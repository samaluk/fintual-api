import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { createAuthenticatedFintualIngestion } from "./authenticated-ingestion.ts"

const OPTIONS = {
  email: "investor@example.com",
  password: "secret-password",
  goalId: "goal-123",
}

test("returns Reference and Recent Goal Performance Data after direct login", async () => {
  const script = createFetchScript([
    response("", 200, "session=sign-in"),
    response("{}", 200, "auth=direct"),
    goalPerformanceResponse("2026-01-01", "graph=reference"),
    goalPerformanceResponse("2026-07-01"),
  ])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  const result = await Effect.runPromise(ingestion(OPTIONS))

  expect(result.reference.balanceGraphDataPoints[0]?.date).toBe("2026-01-01")
  expect(result.recent.balanceGraphDataPoints[0]?.date).toBe("2026-07-01")
  expect(script.requests).toHaveLength(4)
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
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => {
      codeRequests += 1
      return Effect.succeed("123456")
    },
  })

  await Effect.runPromise(ingestion(OPTIONS))

  expect(codeRequests).toBe(1)
  expect(requestBody(script.requests[2])).toMatch(/"code":"123456"/)
  expect(script.requests[3]?.url ?? "").toMatch(/\/gql\/$/)
})

test("fails when email 2FA does not return a code", async () => {
  const script = createFetchScript([response(""), response("{}", 201)])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await expect(Effect.runPromise(ingestion(OPTIONS))).rejects.toMatchObject({
    _tag: "Email2FAFailure",
  })
  expect(script.requests).toHaveLength(2)
})

test("fails with LoginFailed on a 401 initiate_login response", async () => {
  const script = createFetchScript([response(""), response("{}", 401)])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await expect(Effect.runPromise(ingestion(OPTIONS))).rejects.toMatchObject({
    _tag: "LoginFailed",
    status: 401,
  })
})

test("fails on an unexpected login response without exposing its body", async () => {
  const script = createFetchScript([response(""), response("session-token=secret", 418)])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await expect(Effect.runPromise(ingestion(OPTIONS))).rejects.toSatisfy((error) => {
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

test("fails atomically when the reference request fails", async () => {
  const script = createFetchScript([response(""), response("{}"), response("{}", 503)])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await expect(Effect.runPromise(ingestion(OPTIONS))).rejects.toMatchObject({
    _tag: "UnexpectedHttpStatus",
    stage: "Fintual reference Goal Performance Data",
    status: 503,
  })
  expect(script.requests).toHaveLength(3)
})

test("fails atomically when the recent request fails", async () => {
  const script = createFetchScript([
    response(""),
    response("{}"),
    goalPerformanceResponse("2026-01-01"),
    response("{}", 503),
  ])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await expect(Effect.runPromise(ingestion(OPTIONS))).rejects.toMatchObject({
    _tag: "UnexpectedHttpStatus",
    stage: "Fintual recent Goal Performance Data",
    status: 503,
  })
})

test("fails with HttpTransportFailure when a request throws", async () => {
  const script = createFetchScript([response(""), response("{}")])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await expect(Effect.runPromise(ingestion(OPTIONS))).rejects.toSatisfy((error) => {
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
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await expect(Effect.runPromise(ingestion(OPTIONS))).rejects.toMatchObject({
    _tag: "HttpTransportFailure",
    stage: "Fintual sign-in page",
  })
})

describe("fails when Goal Performance Data is malformed or invalid", () => {
  test("malformed JSON", async () => {
    const script = createFetchScript([response(""), response("{}"), response("{")])
    const ingestion = createAuthenticatedFintualIngestion({
      fetch: script.fetch,
      get2FACode: () => Effect.succeed(null),
    })

    await expect(Effect.runPromise(ingestion(OPTIONS))).rejects.toSatisfy((error) => {
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
    const ingestion = createAuthenticatedFintualIngestion({
      fetch: script.fetch,
      get2FACode: () => Effect.succeed(null),
    })

    await expect(Effect.runPromise(ingestion(OPTIONS))).rejects.toMatchObject({
      _tag: "MalformedGoalPerformanceData",
      purpose: "reference",
    })
  })
})

test("propagates cookies and browser headers through the ephemeral session", async () => {
  const script = createFetchScript([
    response("", 200, "session=sign-in"),
    response("{}", 200, "auth=direct"),
    goalPerformanceResponse("2026-01-01", "graph=reference"),
    goalPerformanceResponse("2026-07-01"),
  ])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await Effect.runPromise(ingestion(OPTIONS))

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

function createFetchScript(responses: Response[]): {
  fetch: typeof globalThis.fetch
  requests: RecordedRequest[]
} {
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

function goalPerformanceResponse(date: string, setCookie?: string): Response {
  return response(
    JSON.stringify({
      data: {
        balanceGraphDataPoints: [
          {
            date,
            unrealizedCostBasisAmount: 100,
            unrealizedGainOrLossAmount: 10,
            realizedCostBasisAmount: 90,
            realizedGainOrLossAmount: 5,
            sharesCostBasisAmount: 95,
            sharesValuationAmount: 110,
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
