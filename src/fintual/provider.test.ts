import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "vitest"

import { FintualConfigService, type FintualConfig } from "../env.ts"
import { Email2FACode, Operational, TimedOut } from "./email-2fa.ts"
import { FintualProvider } from "./provider.ts"

const CONFIG: FintualConfig = {
  email: "investor@example.com",
  password: Redacted.make("secret-password"),
  goalId: "goal-123",
  email2FA: null,
}

function withProvider(fetch: typeof globalThis.fetch) {
  return <A, E>(effect: Effect.Effect<A, E, FintualProvider>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provide(FintualProvider.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(FintualConfigService, CONFIG),
    )
}

it.effect("constructs sign-in requests and skips Email 2FA for direct login", () =>
  Effect.gen(function* () {
    const script = createFetchScript([response("", 200, "session=sign-in"), response("{}", 200)])
    let codeRequests = 0

    yield* withProvider(script.fetch)(
      Effect.gen(function* () {
        const provider = yield* FintualProvider
        yield* provider.signIn(() => {
          codeRequests += 1
          return Effect.succeed(Email2FACode.make("123456"))
        })
      }),
    )

    expect(script.requests).toHaveLength(2)
    const [signInPage, initiateLogin] = script.requests
    expect(signInPage.url).toBe("https://fintual.cl/f/sign-in/")
    expect(signInPage.init.redirect).toBe("follow")
    expect(requestHeaders(signInPage).get("Accept")).toContain("text/html")

    expect(initiateLogin.url).toBe("https://fintual.cl/auth/sessions/initiate_login")
    expect(initiateLogin.init.method).toBe("POST")
    expect(requestHeaders(initiateLogin).get("Accept")).toBe("application/json")
    expect(requestHeaders(initiateLogin).get("Content-Type")).toBe("application/json")
    expect(requestHeaders(initiateLogin).get("Referer")).toBe("https://fintual.cl/f/sign-in/")
    expect(requestBody(initiateLogin)).toContain('"email":"investor@example.com"')
    expect(requestBody(initiateLogin)).toContain('"password":"secret-password"')
    expect(codeRequests).toBe(0)
  }),
)

it.effect("requests an Email 2FA Code once and finalizes login when a challenge is detected", () =>
  Effect.gen(function* () {
    const script = createFetchScript([
      response("", 200, "session=sign-in"),
      response("{}", 201, "challenge=email"),
      response("{}", 200, "auth=two-factor"),
    ])
    const supplierTimes: Date[] = []

    yield* withProvider(script.fetch)(
      Effect.gen(function* () {
        const provider = yield* FintualProvider
        yield* provider.signIn((whenSignInBegan) => {
          supplierTimes.push(whenSignInBegan)
          return Effect.succeed(Email2FACode.make("123456"))
        })
      }),
    )

    expect(supplierTimes).toHaveLength(1)
    expect(supplierTimes[0]).toBeInstanceOf(Date)

    const finalizeLogin = script.requests[2]
    expect(finalizeLogin.url).toBe("https://fintual.cl/auth/sessions/finalize_login_web")
    expect(finalizeLogin.init.method).toBe("POST")
    expect(requestHeaders(finalizeLogin).get("Referer")).toBe("https://fintual.cl/f/sign-in/")
    expect(requestBody(finalizeLogin)).toContain('"code":"123456"')
    expect(requestBody(finalizeLogin)).toContain('"password":"secret-password"')
  }),
)

it.effect("fails with LoginFailed when initiate login returns 401", () =>
  Effect.gen(function* () {
    const script = createFetchScript([response(""), response("{}", 401)])
    let codeRequests = 0

    const error = yield* Effect.flip(
      withProvider(script.fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => {
            codeRequests += 1
            return Effect.succeed(Email2FACode.make("123456"))
          })
        }),
      ),
    )

    expect(error).toMatchObject({ _tag: "LoginFailed", status: 401 })
    expect(codeRequests).toBe(0)
    expect(script.requests).toHaveLength(2)
  }),
)

it.effect("fails with UnexpectedHttpStatus when initiate login returns an unexpected status", () =>
  Effect.gen(function* () {
    const script = createFetchScript([response(""), response("{}", 418)])

    const error = yield* Effect.flip(
      withProvider(script.fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual login",
      status: 418,
    })
  }),
)

it.effect("fails with UnexpectedHttpStatus when finalize login returns an unexpected status", () =>
  Effect.gen(function* () {
    const script = createFetchScript([response(""), response("{}", 201), response("{}", 503)])

    const error = yield* Effect.flip(
      withProvider(script.fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual email 2FA",
      status: 503,
    })
  }),
)

it.effect("fails with Email2FAFailure when the code supplier times out", () =>
  Effect.gen(function* () {
    const script = createFetchScript([response(""), response("{}", 201)])

    const error = yield* Effect.flip(
      withProvider(script.fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => Effect.fail(new TimedOut()))
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: "Email2FAFailure",
      stage: "Fintual email 2FA",
    })
    if (error instanceof Error) {
      expect(error.message).toContain("no code received before timeout")
    }
  }),
)

it.effect(
  "fails with Email2FAFailure preserving the cause when the code supplier fails operationally",
  () =>
    Effect.gen(function* () {
      const script = createFetchScript([response(""), response("{}", 201)])
      const imapCause = new Error("IMAP connection refused")

      const error = yield* Effect.flip(
        withProvider(script.fetch)(
          Effect.gen(function* () {
            const provider = yield* FintualProvider
            yield* provider.signIn(() => Effect.fail(new Operational({ cause: imapCause })))
          }),
        ),
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

it.effect("propagates cookies and browser headers through the authenticated session", () =>
  Effect.gen(function* () {
    const script = createFetchScript([
      response("", 200, "session=sign-in"),
      response("{}", 200, "auth=direct"),
      goalPerformanceResponse("2026-01-01", {}, "graph=reference"),
      goalPerformanceResponse("2026-07-01"),
    ])

    yield* withProvider(script.fetch)(
      Effect.gen(function* () {
        const provider = yield* FintualProvider
        yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
        yield* provider.fetchReferenceGoalPerformanceData()
        yield* provider.fetchRecentGoalPerformanceData()
      }),
    )

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

it.effect("decodes valid Reference and Recent Goal Performance Data through the provider", () =>
  Effect.gen(function* () {
    const script = createFetchScript([
      response("", 200, "session=sign-in"),
      response("{}", 200, "auth=direct"),
      goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
      goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
    ])

    const result = yield* withProvider(script.fetch)(
      Effect.gen(function* () {
        const provider = yield* FintualProvider
        yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
        const reference = yield* provider.fetchReferenceGoalPerformanceData()
        const recent = yield* provider.fetchRecentGoalPerformanceData()
        return { reference, recent }
      }),
    )

    expect(result.reference.balanceGraphDataPoints[0]?.date).toBe("2026-01-01")
    expect(result.recent.balanceGraphDataPoints[0]?.date).toBe("2026-07-01")

    const referenceRequest = script.requests[2]
    const recentRequest = script.requests[3]
    expect(referenceRequest.url).toBe("https://fintual.cl/gql/")
    expect(recentRequest.url).toBe("https://fintual.cl/gql/")
    for (const request of [referenceRequest, recentRequest]) {
      expect(request.init.method).toBe("POST")
      expect(requestHeaders(request).get("Accept")).toBe("*/*")
      expect(requestHeaders(request).get("Content-Type")).toBe("application/json")
      expect(requestHeaders(request).get("Referer")).toBe("https://fintual.cl/")
    }
    expect(requestBody(referenceRequest)).toContain('"goalId":"goal-123"')
    expect(requestBody(referenceRequest)).toContain('"timeIntervalCode":"last_six_months"')
    expect(requestBody(recentRequest)).toContain('"timeIntervalCode":"last_month"')
  }),
)

it.effect("fails with UnexpectedHttpStatus when Reference Goal Performance Data is not ok", () =>
  Effect.gen(function* () {
    const script = createFetchScript([response(""), response("{}"), response("{}", 503)])

    const error = yield* Effect.flip(
      withProvider(script.fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
          yield* provider.fetchReferenceGoalPerformanceData()
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual reference Goal Performance Data",
      status: 503,
    })
  }),
)

it.effect("fails with UnexpectedHttpStatus when Recent Goal Performance Data is not ok", () =>
  Effect.gen(function* () {
    const script = createFetchScript([
      response(""),
      response("{}"),
      goalPerformanceResponse("2026-01-01"),
      response("{}", 503),
    ])

    const error = yield* Effect.flip(
      withProvider(script.fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
          yield* provider.fetchReferenceGoalPerformanceData()
          yield* provider.fetchRecentGoalPerformanceData()
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual recent Goal Performance Data",
      status: 503,
    })
  }),
)

it.effect(
  "fails with MalformedGoalPerformanceData when Goal Performance Data is malformed JSON",
  () =>
    Effect.gen(function* () {
      const script = createFetchScript([response(""), response("{}"), response("{")])

      const error = yield* Effect.flip(
        withProvider(script.fetch)(
          Effect.gen(function* () {
            const provider = yield* FintualProvider
            yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
            yield* provider.fetchReferenceGoalPerformanceData()
          }),
        ),
      )

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
      if (error instanceof Error) {
        expect(error.cause).toBeInstanceOf(Error)
      }
    }),
)

it.effect(
  "fails with MalformedGoalPerformanceData when Goal Performance Data has an invalid shape",
  () =>
    Effect.gen(function* () {
      const script = createFetchScript([
        response(""),
        response("{}"),
        response(JSON.stringify({ data: {} })),
      ])

      const error = yield* Effect.flip(
        withProvider(script.fetch)(
          Effect.gen(function* () {
            const provider = yield* FintualProvider
            yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
            yield* provider.fetchReferenceGoalPerformanceData()
          }),
        ),
      )

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
    }),
)

it.effect("fails with MalformedGoalPerformanceData when the GraphQL response contains errors", () =>
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

    const error = yield* Effect.flip(
      withProvider(script.fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
          yield* provider.fetchReferenceGoalPerformanceData()
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: "MalformedGoalPerformanceData",
      purpose: "reference",
    })
  }),
)

it.effect(
  "fails with MalformedGoalPerformanceData when a Goal Performance Data date is invalid",
  () =>
    Effect.gen(function* () {
      const body = goalPerformanceBody("2026-02-31")
      const script = createFetchScript([
        response(""),
        response("{}"),
        response(JSON.stringify(body)),
      ])

      const error = yield* Effect.flip(
        withProvider(script.fetch)(
          Effect.gen(function* () {
            const provider = yield* FintualProvider
            yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
            yield* provider.fetchReferenceGoalPerformanceData()
          }),
        ),
      )

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
    }),
)

it.effect("preserves non-finite wire amounts for snapshot validation", () =>
  Effect.gen(function* () {
    const body = JSON.stringify(goalPerformanceBody("2026-01-01")).replace(
      '"unrealizedCostBasisAmount":100',
      '"unrealizedCostBasisAmount":1e400',
    )
    const script = createFetchScript([response(""), response("{}"), response(body)])

    const result = yield* withProvider(script.fetch)(
      Effect.gen(function* () {
        const provider = yield* FintualProvider
        yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
        return yield* provider.fetchReferenceGoalPerformanceData()
      }),
    )

    expect(result.balanceGraphDataPoints[0]?.unrealizedCostBasisAmount).toBe(
      Number.POSITIVE_INFINITY,
    )
  }),
)

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

    const error = yield* Effect.flip(
      withProvider(fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
          yield* provider.fetchReferenceGoalPerformanceData()
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: "HttpTransportFailure",
      stage: "Fintual reference Goal Performance Data",
    })
    expect(requests).toHaveLength(3)
  }),
)

it.effect("fails with HttpTransportFailure when a response body cannot be read", () =>
  Effect.gen(function* () {
    const brokenBody = response("")
    brokenBody.arrayBuffer = () => Promise.reject(new Error("stream broken"))
    const script = createFetchScript([brokenBody])

    const error = yield* Effect.flip(
      withProvider(script.fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
        }),
      ),
    )

    expect(error).toMatchObject({
      _tag: "HttpTransportFailure",
      stage: "Fintual sign-in page",
    })
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

    const request = withProvider(fetch)(
      Effect.gen(function* () {
        const provider = yield* FintualProvider
        yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
      }),
    )

    const fiber = yield* Effect.forkChild(request)
    yield* Effect.promise(() => requestStarted)
    yield* Fiber.interrupt(fiber)

    expect(observedSignal).toBeDefined()
    expect(observedSignal?.aborted).toBe(true)
  }),
)

it.effect("fails with HttpTransportFailure when the request deadline aborts fetch", () =>
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

    const request = withProvider(fetch)(
      Effect.gen(function* () {
        const provider = yield* FintualProvider
        yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
      }),
    )

    const fiber = yield* Effect.forkChild(request)
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

it.effect(
  "fails with HttpTransportFailure when the deadline interrupts a stalled response body",
  () =>
    Effect.gen(function* () {
      const stalledBody = new Response(new ReadableStream({ start() {} }))
      const script = createFetchScript([stalledBody])

      const request = withProvider(script.fetch)(
        Effect.gen(function* () {
          const provider = yield* FintualProvider
          yield* provider.signIn(() => Effect.succeed(Email2FACode.make("123456")))
        }),
      )

      const fiber = yield* Effect.forkChild(request)
      yield* Effect.promise(() => Promise.resolve())
      yield* TestClock.adjust(Duration.seconds(31))

      const error = yield* Effect.flip(Fiber.join(fiber))

      expect(error).toMatchObject({
        _tag: "HttpTransportFailure",
        stage: "Fintual sign-in page",
      })
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

function requestBody(request: RecordedRequest | undefined): string {
  return typeof request?.init.body === "string" ? request.init.body : ""
}

function requestHeaders(request: RecordedRequest | undefined): Headers {
  return new Headers(request?.init.headers)
}
