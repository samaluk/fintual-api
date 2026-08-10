import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { createAuthenticatedFintualIngestion } from "./authenticated-ingestion.ts"

const OPTIONS = {
  email: "investor@example.com",
  password: "secret-password",
  goalId: "goal-123",
}

void test("returns Reference and Recent Goal Performance Data after direct login", async () => {
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

  assert.equal(result.reference.balanceGraphDataPoints[0]?.date, "2026-01-01")
  assert.equal(result.recent.balanceGraphDataPoints[0]?.date, "2026-07-01")
  assert.equal(script.requests.length, 4)
  assert.match(requestBody(script.requests[2]), /"timeIntervalCode":"last_six_months"/)
  assert.match(requestBody(script.requests[3]), /"timeIntervalCode":"last_month"/)
})

void test("completes email 2FA before it requests Goal Performance Data", async () => {
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

  assert.equal(codeRequests, 1)
  assert.match(requestBody(script.requests[2]), /"code":"123456"/)
  assert.match(script.requests[3]?.url ?? "", /\/gql\/$/)
})

void test("fails when email 2FA does not return a code", async () => {
  const script = createFetchScript([response(""), response("{}", 201)])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await assert.rejects(Effect.runPromise(ingestion(OPTIONS)), /no code received before timeout/)
  assert.equal(script.requests.length, 2)
})

void test("fails on an unexpected login response without exposing its body", async () => {
  const script = createFetchScript([response(""), response("session-token=secret", 418)])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await assert.rejects(Effect.runPromise(ingestion(OPTIONS)), (error) =>
    errorMessageIncludes(error, "Fintual login: unexpected HTTP status 418", "secret"),
  )
})

void test("fails atomically when the reference request fails", async () => {
  const script = createFetchScript([response(""), response("{}"), response("{}", 503)])
  const ingestion = createAuthenticatedFintualIngestion({
    fetch: script.fetch,
    get2FACode: () => Effect.succeed(null),
  })

  await assert.rejects(
    Effect.runPromise(ingestion(OPTIONS)),
    /Fintual reference Goal Performance Data: unexpected HTTP status 503/,
  )
  assert.equal(script.requests.length, 3)
})

void test("fails atomically when the recent request fails", async () => {
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

  await assert.rejects(
    Effect.runPromise(ingestion(OPTIONS)),
    /Fintual recent Goal Performance Data: unexpected HTTP status 503/,
  )
})

void test("fails when Goal Performance Data is malformed or invalid", async (context) => {
  await context.test("malformed JSON", async () => {
    const script = createFetchScript([response(""), response("{}"), response("{")])
    const ingestion = createAuthenticatedFintualIngestion({
      fetch: script.fetch,
      get2FACode: () => Effect.succeed(null),
    })

    await assert.rejects(Effect.runPromise(ingestion(OPTIONS)), /validation failed/)
  })

  await context.test("invalid shape", async () => {
    const script = createFetchScript([
      response(""),
      response("{}"),
      response(JSON.stringify({ data: {} })),
    ])
    const ingestion = createAuthenticatedFintualIngestion({
      fetch: script.fetch,
      get2FACode: () => Effect.succeed(null),
    })

    await assert.rejects(Effect.runPromise(ingestion(OPTIONS)), /validation failed/)
  })
})

void test("propagates cookies and browser headers through the ephemeral session", async () => {
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

  assert.equal(requestHeaders(script.requests[0]).get("Cookie"), null)
  assert.equal(requestHeaders(script.requests[1]).get("Cookie"), "session=sign-in")
  assert.equal(requestHeaders(script.requests[2]).get("Cookie"), "session=sign-in; auth=direct")
  assert.equal(
    requestHeaders(script.requests[3]).get("Cookie"),
    "session=sign-in; auth=direct; graph=reference",
  )

  for (const request of script.requests) {
    assert.match(requestHeaders(request).get("User-Agent") ?? "", /Mozilla\/5\.0/)
    assert.equal(requestHeaders(request).get("Origin"), "https://fintual.cl")
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

function errorMessageIncludes(error: unknown, included: string, excluded: string): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  assert.match(error.message, new RegExp(included))
  assert.doesNotMatch(error.message, new RegExp(excluded))
  return true
}
