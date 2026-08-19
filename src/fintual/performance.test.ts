import * as fs from "node:fs"
import * as path from "node:path"

import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect } from "vitest"

import { Email2FAConfigService, FintualConfigService, type FintualConfig } from "../env.ts"
import { getErrorMessage } from "../logging.ts"
import { Email2FACode, Email2FAService, Operational, TimedOut } from "./email-2fa.ts"
import { FintualPerformance, PERFORMANCE_SNAPSHOT_PATH } from "./performance.ts"

const CONFIG: FintualConfig = {
  email: "investor@example.com",
  password: Redacted.make("secret-password"),
  goalId: "goal-123",
}

const EMAIL_2FA_CONFIG = {
  userEmail: "inbox@example.com",
  appPassword: Redacted.make("app-password"),
  host: "imap.example.com",
  port: 993,
  debug: false,
  sender: "notifications@example.com",
}

function performanceProgram(
  fetch: typeof globalThis.fetch,
  options: {
    email2FAConfig?: typeof EMAIL_2FA_CONFIG | null
    get2FACode?: Email2FAService["Service"]["get2FACode"]
    config?: FintualConfig
  } = {},
) {
  const program = Effect.gen(function* () {
    const service = yield* FintualPerformance
    return yield* service.fetchPerformanceSnapshot
  })

  return program.pipe(
    Effect.provide(FintualPerformance.layer),
    Effect.provideService(FintualConfigService, options.config ?? CONFIG),
    Effect.provideService(
      Email2FAConfigService,
      options.email2FAConfig === null
        ? Option.none()
        : Option.some(options.email2FAConfig ?? EMAIL_2FA_CONFIG),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(
      options.email2FAConfig === null
        ? Layer.empty
        : Layer.succeed(Email2FAService, {
            get2FACode: options.get2FACode ?? (() => Effect.succeed(Email2FACode.make("123456"))),
          }),
    ),
  )
}

it.effect(
  "returns a validated Performance Snapshot after direct login and persists the inspection artifact",
  () =>
    Effect.gen(function* () {
      const script = createFetchScript([
        response("", 200, "session=sign-in"),
        response("{}", 200, "auth=direct"),
        goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
        goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
      ])

      const snapshot = yield* performanceProgram(script.fetch)

      expect(snapshot).toEqual({
        balance: [
          { date: Date.parse("2026-07-01"), value: 115, difference: 5, real_difference: 5 },
        ],
        deposits: [{ date: Date.parse("2026-07-01"), value: 90, difference: 10 }],
      })

      const writtenSnapshot: unknown = JSON.parse(
        fs.readFileSync(PERFORMANCE_SNAPSHOT_PATH, "utf-8"),
      )
      expect(writtenSnapshot).toEqual(snapshot)
      expect(script.requests).toHaveLength(4)
    }),
)

it.effect("builds the live layer without Email 2FA configuration", () =>
  Effect.gen(function* () {
    const service = yield* FintualPerformance

    expect(Effect.isEffect(service.fetchPerformanceSnapshot)).toBe(true)
  }).pipe(
    Effect.provide(FintualPerformance.live),
    Effect.provideService(FintualConfigService, CONFIG),
    Effect.provideService(Email2FAConfigService, Option.none()),
  ),
)

it.effect("direct login succeeds when Email 2FA is not configured", () =>
  Effect.gen(function* () {
    let codeRequests = 0
    const script = createFetchScript([
      response("", 200, "session=sign-in"),
      response("{}", 200),
      goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
      goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
    ])

    const snapshot = yield* performanceProgram(script.fetch, {
      email2FAConfig: null,
      get2FACode: () => {
        codeRequests += 1
        return Effect.succeed(Email2FACode.make("123456"))
      },
    })

    expect(codeRequests).toBe(0)
    expect(snapshot.balance).toHaveLength(1)
  }),
)

it.effect("requests an Email 2FA Code and completes 2FA sign-in when a challenge is detected", () =>
  Effect.gen(function* () {
    let codeRequests = 0
    const script = createFetchScript([
      response("", 200, "session=sign-in"),
      response("{}", 201, "challenge=email"),
      response("{}", 200, "auth=two-factor"),
      goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
      goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
    ])

    const snapshot = yield* performanceProgram(script.fetch, {
      get2FACode: () => {
        codeRequests += 1
        return Effect.succeed(Email2FACode.make("123456"))
      },
    })

    expect(codeRequests).toBe(1)
    expect(snapshot.balance).toHaveLength(1)

    const finalizeLogin = script.requests[2]
    expect(finalizeLogin.url).toBe("https://fintual.cl/auth/sessions/finalize_login_web")
    expect(requestBody(finalizeLogin)).toContain('"code":"123456"')
  }),
)

describe("fails when Email 2FA cannot produce a code", () => {
  it.effect("login requires 2FA but Gmail credentials are not configured", () =>
    Effect.gen(function* () {
      const script = createFetchScript([
        response("", 200, "session=sign-in"),
        response("{}", 201, "challenge=email"),
      ])

      const error = yield* Effect.flip(
        performanceProgram(script.fetch, {
          email2FAConfig: null,
        }),
      )

      expect(error).toMatchObject({
        _tag: "Email2FAFailure",
        stage: "Fintual email 2FA",
        message: "Fintual email 2FA: Gmail IMAP credentials not configured",
      })
    }),
  )

  it.effect("code retrieval times out", () =>
    Effect.gen(function* () {
      const script = createFetchScript([
        response("", 200, "session=sign-in"),
        response("{}", 201, "challenge=email"),
      ])

      const error = yield* Effect.flip(
        performanceProgram(script.fetch, {
          get2FACode: () => Effect.fail(new TimedOut()),
        }),
      )

      expect(error).toMatchObject({
        _tag: "Email2FAFailure",
        stage: "Fintual email 2FA",
        message: "Fintual email 2FA: no code received before timeout",
      })
    }),
  )

  it.effect("operational failure preserves its IMAP cause and sign-in stage", () =>
    Effect.gen(function* () {
      const script = createFetchScript([
        response("", 200, "session=sign-in"),
        response("{}", 201, "challenge=email"),
      ])
      const imapCause = new Error("IMAP connection refused")

      const error = yield* Effect.flip(
        performanceProgram(script.fetch, {
          get2FACode: () => Effect.fail(new Operational({ cause: imapCause })),
        }),
      )

      expect(error).toMatchObject({
        _tag: "Email2FAFailure",
        stage: "Fintual email 2FA",
        cause: imapCause,
      })
      if (error instanceof Error) {
        expect(error.cause).toBe(imapCause)
      }
    }),
  )
})

it.effect("fails with LoginFailed when the provider rejects sign-in with 401", () =>
  Effect.gen(function* () {
    const script = createFetchScript([response(""), response("{}", 401)])

    const error = yield* Effect.flip(performanceProgram(script.fetch))

    expect(error).toMatchObject({
      _tag: "LoginFailed",
      status: 401,
    })
  }),
)

it.effect("fails on an unexpected sign-in status", () =>
  Effect.gen(function* () {
    const script = createFetchScript([response(""), response("{}", 418)])

    const error = yield* Effect.flip(performanceProgram(script.fetch))

    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual login",
      status: 418,
    })
  }),
)

it.effect("fails on an unexpected finalize login status", () =>
  Effect.gen(function* () {
    const script = createFetchScript([
      response(""),
      response("{}", 201, "challenge=email"),
      response("{}", 503),
    ])

    const error = yield* Effect.flip(performanceProgram(script.fetch))

    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual email 2FA",
      status: 503,
    })
  }),
)

it.effect("propagates cookies and browser headers through the authenticated session", () =>
  Effect.gen(function* () {
    const script = createFetchScript([
      response("", 200, "session=sign-in"),
      response("{}", 200, "auth=direct"),
      goalPerformanceResponse("2026-01-01", {}, "graph=reference"),
      goalPerformanceResponse("2026-07-01"),
    ])

    yield* performanceProgram(script.fetch)

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
  }),
)

describe("fails when Goal Performance Data is unavailable", () => {
  it.effect("reference request failure", () =>
    Effect.gen(function* () {
      const script = createFetchScript([response(""), response("{}"), response("{}", 503)])

      const error = yield* Effect.flip(performanceProgram(script.fetch))

      expect(error).toMatchObject({
        _tag: "UnexpectedHttpStatus",
        stage: "Fintual reference Goal Performance Data",
        status: 503,
      })
    }),
  )

  it.effect("recent request failure", () =>
    Effect.gen(function* () {
      const script = createFetchScript([
        response(""),
        response("{}"),
        goalPerformanceResponse("2026-01-01"),
        response("{}", 503),
      ])

      const error = yield* Effect.flip(performanceProgram(script.fetch))

      expect(error).toMatchObject({
        _tag: "UnexpectedHttpStatus",
        stage: "Fintual recent Goal Performance Data",
        status: 503,
      })
    }),
  )

  it.effect("malformed JSON in GraphQL response", () =>
    Effect.gen(function* () {
      const script = createFetchScript([response(""), response("{}"), response("{")])

      const error = yield* Effect.flip(performanceProgram(script.fetch))

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
      if (error instanceof Error) {
        expect(error.cause).toBeInstanceOf(Error)
      }
    }),
  )

  it.effect("GraphQL response contains errors", () =>
    Effect.gen(function* () {
      const script = createFetchScript([
        response(""),
        response("{}"),
        response(
          JSON.stringify({
            ...goalPerformanceBody("2026-01-01"),
            errors: [{ message: "request failed" }],
          }),
        ),
      ])

      const error = yield* Effect.flip(performanceProgram(script.fetch))

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
    }),
  )

  it.effect("invalid date in Goal Performance Data", () =>
    Effect.gen(function* () {
      const body = goalPerformanceBody("2026-02-31")
      const script = createFetchScript([
        response(""),
        response("{}"),
        response(JSON.stringify(body)),
      ])

      const error = yield* Effect.flip(performanceProgram(script.fetch))

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
    }),
  )

  it.effect("non-finite wire amounts in GraphQL response", () =>
    Effect.gen(function* () {
      const body = JSON.stringify(goalPerformanceBody("2026-01-01")).replace(
        '"unrealizedCostBasisAmount":100',
        '"unrealizedCostBasisAmount":1e400',
      )
      const script = createFetchScript([response(""), response("{}"), response(body)])

      const error = yield* Effect.flip(performanceProgram(script.fetch))

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
    }),
  )
})

it.effect("fails with HttpTransportFailure when a request throws", () =>
  Effect.gen(function* () {
    const requests: RecordedRequest[] = []
    const fetch: typeof globalThis.fetch = async (input, init = {}) => {
      requests.push({ url: requestUrl(input), init })
      if (requests.length === 3) {
        throw new TypeError("network down")
      }
      return new Response("", { status: 200 })
    }

    const error = yield* Effect.flip(performanceProgram(fetch))

    expect(error).toMatchObject({
      _tag: "HttpTransportFailure",
      stage: "Fintual reference Goal Performance Data",
    })
    expect(requests).toHaveLength(3)
  }),
)

it.effect("aborts the underlying fetch when its request fiber is interrupted", () =>
  Effect.gen(function* () {
    let observedSignal: AbortSignal | undefined
    let resolveRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve
    })

    const fetch: typeof globalThis.fetch = async (_input, init = {}) => {
      observedSignal = init.signal ?? undefined
      resolveRequestStarted()

      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    }

    const fiber = yield* Effect.forkChild(performanceProgram(fetch))
    yield* Effect.promise(() => requestStarted)
    yield* Fiber.interrupt(fiber)

    expect(observedSignal).toBeDefined()
    expect(observedSignal?.aborted).toBe(true)
  }),
)

it.effect("fails with HttpTransportFailure when request times out", () =>
  Effect.gen(function* () {
    let observedSignal: AbortSignal | undefined
    let resolveRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve
    })

    const fetch: typeof globalThis.fetch = async (_input, init = {}) => {
      observedSignal = init.signal ?? undefined
      resolveRequestStarted()

      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    }

    const fiber = yield* Effect.forkChild(performanceProgram(fetch))
    yield* Effect.promise(() => requestStarted)
    yield* TestClock.adjust(Duration.seconds(31))

    const error = yield* Effect.flip(Fiber.join(fiber))

    expect(error).toMatchObject({
      _tag: "HttpTransportFailure",
      stage: "Fintual sign-in page",
    })
    expect(observedSignal?.aborted).toBe(true)
  }),
)

it.effect("fails with MalformedPerformanceSnapshot when the fold output is invalid", () =>
  Effect.gen(function* () {
    const emptyPointsBody = { data: { balanceGraphDataPoints: [] } }
    const script = createFetchScript([
      response(""),
      response("{}"),
      response(JSON.stringify(emptyPointsBody)),
      response(JSON.stringify(emptyPointsBody)),
    ])

    const error = yield* Effect.flip(performanceProgram(script.fetch))

    expect(error).toMatchObject({
      _tag: "MalformedPerformanceSnapshot",
    })
  }),
)

it.effect("starts with zero differences when reference does not precede the recent window", () =>
  Effect.gen(function* () {
    const script = createFetchScript([
      response("", 200, "session=sign-in"),
      response("{}", 200, "auth=direct"),
      goalPerformanceResponse("2026-08-01", { costBasis: 800, valuation: 1000 }),
      goalPerformanceResponse("2026-08-01", { costBasis: 850, valuation: 1100 }),
    ])

    const snapshot = yield* performanceProgram(script.fetch)

    expect(snapshot).toEqual({
      balance: [{ date: Date.parse("2026-08-01"), value: 1100, difference: 0, real_difference: 0 }],
      deposits: [{ date: Date.parse("2026-08-01"), value: 850, difference: 0 }],
    })
  }),
)

it.effect("folds multiple reference and recent points into a Performance Snapshot", () =>
  Effect.gen(function* () {
    const script = createFetchScript([
      response("", 200, "session=sign-in"),
      response("{}", 200, "auth=direct"),
      multiPointGoalPerformanceResponse([{ date: "2026-07-30", costBasis: 800, valuation: 1000 }]),
      multiPointGoalPerformanceResponse([
        { date: "2026-08-01", costBasis: 850, valuation: 1100 },
        { date: "2026-08-02", costBasis: 900, valuation: 1150 },
      ]),
    ])

    const snapshot = yield* performanceProgram(script.fetch)

    expect(snapshot).toEqual({
      balance: [
        { date: Date.parse("2026-08-01"), value: 1100, difference: 50, real_difference: 50 },
        { date: Date.parse("2026-08-02"), value: 1150, difference: 0, real_difference: 0 },
      ],
      deposits: [
        { date: Date.parse("2026-08-01"), value: 850, difference: 50 },
        { date: Date.parse("2026-08-02"), value: 900, difference: 50 },
      ],
    })
  }),
)

it.effect("fails with SnapshotWriteFailure when the snapshot file cannot be written", () =>
  Effect.gen(function* () {
    const originalContents = readFileIfPresent(PERFORMANCE_SNAPSHOT_PATH)
    fs.mkdirSync(path.dirname(PERFORMANCE_SNAPSHOT_PATH), { recursive: true })

    try {
      if (originalContents !== null) {
        fs.rmSync(PERFORMANCE_SNAPSHOT_PATH)
      }
      fs.mkdirSync(PERFORMANCE_SNAPSHOT_PATH, { recursive: true })

      const script = createFetchScript([
        response("", 200, "session=sign-in"),
        response("{}", 200, "auth=direct"),
        goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
        goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
      ])

      const error = yield* Effect.flip(performanceProgram(script.fetch))

      expect(error).toMatchObject({
        _tag: "SnapshotWriteFailure",
      })
      expect(getErrorMessage(error)).toContain("Failed to write performance snapshot artifact")
    } finally {
      fs.rmSync(PERFORMANCE_SNAPSHOT_PATH, { force: true, recursive: true })
      restoreFile(PERFORMANCE_SNAPSHOT_PATH, originalContents)
    }
  }),
)

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

function goalPerformanceBody(
  date: string,
  amounts: { costBasis?: number; valuation?: number } = {},
): Record<string, unknown> {
  return {
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
  }
}

function goalPerformanceResponse(
  date: string,
  amounts: { costBasis?: number; valuation?: number } = {},
  setCookie?: string,
): Response {
  return response(JSON.stringify(goalPerformanceBody(date, amounts)), 200, setCookie)
}

function multiPointGoalPerformanceResponse(
  points: ReadonlyArray<{
    date: string
    costBasis?: number
    valuation?: number
  }>,
): Response {
  return response(
    JSON.stringify({
      data: {
        balanceGraphDataPoints: points.map((p) => ({
          date: p.date,
          unrealizedCostBasisAmount: p.costBasis ?? 100,
          unrealizedGainOrLossAmount: 10,
          realizedCostBasisAmount: 90,
          realizedGainOrLossAmount: 5,
          sharesCostBasisAmount: 95,
          sharesValuationAmount: p.valuation ?? 110,
          pendingFulfillmentReinvestmentDepositsCostBasisAmount: 0,
          pendingFulfillmentReinvestmentDepositsAmount: 0,
          withdrawnAmount: 0,
        })),
      },
    }),
  )
}

function requestBody(request: RecordedRequest | undefined): string {
  return typeof request?.init.body === "string" ? request.init.body : ""
}

function requestHeaders(request: RecordedRequest | undefined): Headers {
  return new Headers(request?.init.headers)
}

function readFileIfPresent(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null
  }

  return fs.readFileSync(filePath, "utf-8")
}

function restoreFile(filePath: string, contents: string | null): void {
  if (contents === null) {
    fs.rmSync(filePath, { force: true })
    return
  }

  fs.writeFileSync(filePath, contents, "utf-8")
}
