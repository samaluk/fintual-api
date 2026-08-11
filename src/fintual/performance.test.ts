import { Effect, Redacted } from "effect"
import { describe, expect, test } from "vitest"
import { FintualConfigService, type FintualConfig } from "../env.ts"
import { SnapshotWriter, type PerformanceSnapshot } from "../performance-snapshot.ts"
import { FetchService } from "./authenticated-ingestion.ts"
import { Email2FAService } from "./email-2fa.ts"
import { Email2FACode, Operational, TimedOut } from "./email-2fa/retrieve.ts"
import { SnapshotWriteFailure } from "./fintual-error.ts"
import { FintualPerformance } from "./performance.ts"

const CONFIG: FintualConfig = {
  email: "investor@example.com",
  password: Redacted.make("secret-password"),
  goalId: "goal-123",
  email2FA: {
    userEmail: "inbox@example.com",
    appPassword: Redacted.make("app-password"),
    host: "imap.example.com",
    port: 993,
    debug: false,
    sender: "notifications@example.com",
  },
}

interface TestOverrides {
  get2FACode?: Email2FAService["Service"]["get2FACode"]
  write?: SnapshotWriter["Service"]["write"]
  config?: FintualConfig
}

function performanceProgram(script: FetchScript, overrides: TestOverrides = {}) {
  const program = Effect.gen(function* () {
    const service = yield* FintualPerformance
    return yield* service.fetchPerformanceSnapshot()
  })

  return program.pipe(
    Effect.provide(FintualPerformance.layer),
    Effect.provideService(FintualConfigService, overrides.config ?? CONFIG),
    Effect.provide(FetchService.layer(script.fetch)),
    Effect.provideService(Email2FAService, {
      get2FACode: overrides.get2FACode ?? (() => Effect.succeed(Email2FACode.make("123456"))),
    }),
    Effect.provideService(SnapshotWriter, {
      write: overrides.write ?? (() => Effect.void),
    }),
  )
}

test("returns a validated Performance Snapshot after direct login", async () => {
  const written: PerformanceSnapshot[] = []
  const script = createFetchScript([
    response("", 200, "session=sign-in"),
    response("{}", 200, "auth=direct"),
    goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }, "graph=reference"),
    goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
  ])

  const snapshot = await Effect.runPromise(
    performanceProgram(script, { write: (value) => Effect.sync(() => written.push(value)) }),
  )

  expect(snapshot).toEqual({
    balance: [{ date: Date.parse("2026-07-01"), value: 115, difference: 5, real_difference: 5 }],
    deposits: [{ date: Date.parse("2026-07-01"), value: 90, difference: 10 }],
  })
  expect(written).toEqual([snapshot])
  expect(script.requests).toHaveLength(4)
  expect(requestBody(script.requests[1])).toContain('"password":"secret-password"')
  expect(requestBody(script.requests[2])).toMatch(/"timeIntervalCode":"last_six_months"/)
  expect(requestBody(script.requests[3])).toMatch(/"timeIntervalCode":"last_month"/)
})

test("completes email 2FA before it requests Goal Performance Data", async () => {
  const script = createFetchScript([
    response("", 200, "session=sign-in"),
    response("{}", 201, "challenge=email"),
    response("{}", 200, "auth=two-factor"),
    goalPerformanceResponse("2026-01-01"),
    goalPerformanceResponse("2026-07-01"),
  ])
  let codeRequests = 0

  const snapshot = await Effect.runPromise(
    performanceProgram(script, {
      get2FACode: () => {
        codeRequests += 1
        return Effect.succeed(Email2FACode.make("123456"))
      },
    }),
  )

  expect(snapshot.balance).toHaveLength(1)
  expect(codeRequests).toBe(1)
  expect(requestBody(script.requests[1])).toContain('"password":"secret-password"')
  expect(requestBody(script.requests[2])).toContain('"password":"secret-password"')
  expect(requestBody(script.requests[2])).toMatch(/"code":"123456"/)
  expect(script.requests[3]?.url ?? "").toMatch(/\/gql\/$/)
})

describe("fails when email 2FA cannot produce a code", () => {
  test("login requires 2FA but Gmail credentials are not configured", async () => {
    const script = createFetchScript([response(""), response("{}", 201)])
    let codeRequests = 0

    await expect(
      Effect.runPromise(
        performanceProgram(script, {
          config: { ...CONFIG, email2FA: null },
          get2FACode: () => {
            codeRequests += 1
            return Effect.succeed(Email2FACode.make("123456"))
          },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "Email2FAFailure",
      stage: "Fintual email 2FA",
      message: "Fintual email 2FA: Gmail IMAP credentials not configured",
    })
    expect(codeRequests).toBe(0)
    expect(script.requests).toHaveLength(2)
  })

  test("code retrieval times out", async () => {
    const script = createFetchScript([response(""), response("{}", 201)])

    await expect(
      Effect.runPromise(
        performanceProgram(script, {
          get2FACode: () => Effect.fail(new TimedOut()),
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "Email2FAFailure",
      stage: "Fintual email 2FA",
      message: "Fintual email 2FA: no code received before timeout",
    })
  })

  test("operational failure preserves its IMAP cause and sign-in stage", async () => {
    const script = createFetchScript([response(""), response("{}", 201)])
    const imapCause = new Error("IMAP connection refused")

    await expect(
      Effect.runPromise(
        performanceProgram(script, {
          get2FACode: () => Effect.fail(new Operational({ cause: imapCause })),
        }),
      ),
    ).rejects.toSatisfy((error) => {
      expect(error).toMatchObject({
        _tag: "Email2FAFailure",
        stage: "Fintual email 2FA",
        cause: imapCause,
      })
      if (error instanceof Error) {
        expect(error.cause).toBe(imapCause)
      }
      return true
    })
  })
})

test("fails with LoginFailed on a 401 initiate_login response", async () => {
  const script = createFetchScript([response(""), response("{}", 401)])

  await expect(Effect.runPromise(performanceProgram(script))).rejects.toMatchObject({
    _tag: "LoginFailed",
    status: 401,
  })
})

test("fails on an unexpected login response without exposing its body", async () => {
  const script = createFetchScript([response(""), response("session-token=secret", 418)])

  await expect(Effect.runPromise(performanceProgram(script))).rejects.toSatisfy((error) => {
    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual login",
      status: 418,
    })
    expect(error).toBeInstanceOf(Error)
    if (error instanceof Error) {
      expect(error.message).not.toContain("secret")
    }
    return true
  })
})

describe("fails atomically when a Goal Performance Data request fails", () => {
  test("reference request", async () => {
    const script = createFetchScript([response(""), response("{}"), response("{}", 503)])

    await expect(Effect.runPromise(performanceProgram(script))).rejects.toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual reference Goal Performance Data",
      status: 503,
    })
    expect(script.requests).toHaveLength(3)
  })

  test("recent request", async () => {
    const script = createFetchScript([
      response(""),
      response("{}"),
      goalPerformanceResponse("2026-01-01"),
      response("{}", 503),
    ])

    await expect(Effect.runPromise(performanceProgram(script))).rejects.toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual recent Goal Performance Data",
      status: 503,
    })
  })
})

test("fails with HttpTransportFailure when a request throws", async () => {
  const script = createFetchScript([response(""), response("{}")])

  await expect(Effect.runPromise(performanceProgram(script))).rejects.toSatisfy((error) => {
    expect(error).toMatchObject({
      _tag: "HttpTransportFailure",
      stage: "Fintual reference Goal Performance Data",
    })
    if (error instanceof Error) {
      expect(error.cause).toBeInstanceOf(Error)
    }
    return true
  })
})

test("fails with HttpTransportFailure when a response body cannot be read", async () => {
  const brokenBody = response("")
  brokenBody.text = () => Promise.reject(new Error("stream broken"))
  const script = createFetchScript([brokenBody])

  await expect(Effect.runPromise(performanceProgram(script))).rejects.toMatchObject({
    _tag: "HttpTransportFailure",
    stage: "Fintual sign-in page",
  })
})

describe("fails when Goal Performance Data is malformed or invalid", () => {
  test("malformed JSON", async () => {
    const script = createFetchScript([response(""), response("{}"), response("{")])

    await expect(Effect.runPromise(performanceProgram(script))).rejects.toSatisfy((error) => {
      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
      if (error instanceof Error) {
        expect(error.cause).toBeInstanceOf(Error)
      }
      return true
    })
  })

  test("invalid shape", async () => {
    const script = createFetchScript([
      response(""),
      response("{}"),
      response(JSON.stringify({ data: {} })),
    ])

    await expect(Effect.runPromise(performanceProgram(script))).rejects.toMatchObject({
      _tag: "MalformedGoalPerformanceData",
      purpose: "reference",
    })
  })
})

test("fails with MalformedPerformanceSnapshot when the fold output is invalid", async () => {
  const script = createFetchScript([
    response(""),
    response("{}"),
    goalPerformanceResponse("2026-01-01"),
    response(JSON.stringify({ data: { balanceGraphDataPoints: [] } })),
  ])

  await expect(Effect.runPromise(performanceProgram(script))).rejects.toMatchObject({
    _tag: "MalformedPerformanceSnapshot",
  })
})

test("fails with SnapshotWriteFailure when the snapshot cannot be written", async () => {
  const script = createFetchScript([
    response(""),
    response("{}"),
    goalPerformanceResponse("2026-01-01"),
    goalPerformanceResponse("2026-07-01"),
  ])

  await expect(
    Effect.runPromise(
      performanceProgram(script, {
        write: () => Effect.fail(new SnapshotWriteFailure({ cause: new Error("disk full") })),
      }),
    ),
  ).rejects.toSatisfy((error) => {
    expect(error).toMatchObject({ _tag: "SnapshotWriteFailure" })
    if (error instanceof Error) {
      expect(error.cause).toBeInstanceOf(Error)
    }
    return true
  })
})

test("propagates cookies and browser headers through the ephemeral session", async () => {
  const script = createFetchScript([
    response("", 200, "session=sign-in"),
    response("{}", 200, "auth=direct"),
    goalPerformanceResponse("2026-01-01", {}, "graph=reference"),
    goalPerformanceResponse("2026-07-01"),
  ])

  await Effect.runPromise(performanceProgram(script))

  expect(requestHeaders(script.requests[0]).get("Cookie")).toBeNull()
  expect(requestHeaders(script.requests[1]).get("Cookie")).toBe("session=sign-in")
  expect(requestHeaders(script.requests[2]).get("Cookie")).toBe("session=sign-in; auth=direct")
  expect(requestHeaders(script.requests[3]).get("Cookie")).toBe(
    "session=sign-in; auth=direct; graph=reference",
  )

  for (const request of script.requests) {
    expect(requestHeaders(request).get("User-Agent") ?? "").toMatch(/Mozilla\/5\.0/)
    expect(requestHeaders(request).get("Origin")).toBe("https://fintual.cl")
  }
})

interface RecordedRequest {
  url: string
  init: RequestInit
}

interface FetchScript {
  fetch: typeof globalThis.fetch
  requests: RecordedRequest[]
}

function createFetchScript(responses: Response[]): FetchScript {
  const requests: RecordedRequest[] = []
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = requestUrl(input)
    requests.push({ url, init })
    const nextResponse = responses.shift()
    if (!nextResponse) {
      throw new Error(`Unexpected request to ${url}`)
    }
    return nextResponse
  }

  return { fetch, requests }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input
  }

  return input instanceof URL ? input.href : input.url
}

function response(body = "", status = 200, setCookie?: string): Response {
  return new Response(body, {
    status,
    headers: setCookie ? { "Set-Cookie": setCookie } : undefined,
  })
}

function goalPerformanceResponse(
  date: string,
  amounts: { costBasis?: number; valuation?: number } = {},
  setCookie?: string,
): Response {
  return response(
    JSON.stringify({
      data: {
        balanceGraphDataPoints: [
          {
            date,
            unrealizedCostBasisAmount: amounts.costBasis ?? 100,
            unrealizedGainOrLossAmount: 10,
            realizedCostBasisAmount: 90,
            realizedGainOrLossAmount: 5,
            sharesCostBasisAmount: 95,
            sharesValuationAmount: amounts.valuation ?? 110,
            pendingFulfillmentReinvestmentDepositsCostBasisAmount: 0,
            pendingFulfillmentReinvestmentDepositsAmount: 0,
            withdrawnAmount: 0,
          },
        ],
      },
    }),
    200,
    setCookie,
  )
}

function requestBody(request: RecordedRequest | undefined): string {
  return typeof request?.init.body === "string" ? request.init.body : ""
}

function requestHeaders(request: RecordedRequest | undefined): Headers {
  return new Headers(request?.init.headers)
}
