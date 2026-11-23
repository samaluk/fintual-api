import * as fs from "node:fs"
import * as path from "node:path"

import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { http, HttpResponse, type PathParams } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest"

import { Email2FAConfigService, FintualConfigService, type FintualConfig } from "../env.ts"
import { getErrorMessage } from "../logging.ts"
import { Email2FACode, Email2FAService, Operational, TimedOut } from "./email-2fa.ts"
import { FintualPerformance, PERFORMANCE_SNAPSHOT_PATH } from "./performance.ts"

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

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
      const script = createHttpScenario({
        signIn: response("", 200, "session=sign-in"),
        login: response("{}", 200, "auth=direct"),
        reference: goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
        recent: goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
      })

      const snapshot = yield* performanceProgram()

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
      expect(Object.keys(script.byRoute)).toEqual(["signIn", "login", "reference", "recent"])
      expect(JSON.parse(requestBody(script.byRoute.login))).toEqual({
        email: CONFIG.email,
        password: "secret-password",
      })
      expect(JSON.parse(requestBody(script.byRoute.reference))).toMatchObject({
        variables: { goalId: CONFIG.goalId, timeIntervalCode: "last_six_months" },
      })
      expect(JSON.parse(requestBody(script.byRoute.recent))).toMatchObject({
        variables: { goalId: CONFIG.goalId, timeIntervalCode: "last_month" },
      })
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
    createHttpScenario({
      signIn: response("", 200, "session=sign-in"),
      login: response("{}", 200),
      reference: goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
      recent: goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
    })

    const snapshot = yield* performanceProgram({
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
    const script = createHttpScenario({
      signIn: response("", 200, "session=sign-in"),
      login: response("{}", 201, "challenge=email"),
      finalizeLogin: response("{}", 200, "auth=two-factor"),
      reference: goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
      recent: goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
    })

    const snapshot = yield* performanceProgram({
      get2FACode: () => {
        codeRequests += 1
        return Effect.succeed(Email2FACode.make("123456"))
      },
    })

    expect(codeRequests).toBe(1)
    expect(snapshot.balance).toHaveLength(1)

    const finalizeLogin = script.byRoute.finalizeLogin
    expect(finalizeLogin?.url).toBe("https://fintual.cl/auth/sessions/finalize_login_web")
    expect(requestBody(finalizeLogin)).toContain('"code":"123456"')
  }),
)

describe("fails when Email 2FA cannot produce a code", () => {
  it.effect("login requires 2FA but Gmail credentials are not configured", () =>
    Effect.gen(function* () {
      createHttpScenario({
        signIn: response("", 200, "session=sign-in"),
        login: response("{}", 201, "challenge=email"),
      })

      const error = yield* Effect.flip(
        performanceProgram({
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
      createHttpScenario({
        signIn: response("", 200, "session=sign-in"),
        login: response("{}", 201, "challenge=email"),
      })

      const error = yield* Effect.flip(
        performanceProgram({
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
      createHttpScenario({
        signIn: response("", 200, "session=sign-in"),
        login: response("{}", 201, "challenge=email"),
      })
      const imapCause = new Error("IMAP connection refused")

      const error = yield* Effect.flip(
        performanceProgram({
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
    createHttpScenario({
      signIn: response(""),
      login: response("{}", 401),
    })

    const error = yield* Effect.flip(performanceProgram())

    expect(error).toMatchObject({
      _tag: "LoginFailed",
      status: 401,
    })
  }),
)

it.effect("fails on an unexpected sign-in status", () =>
  Effect.gen(function* () {
    createHttpScenario({
      signIn: response(""),
      login: response("{}", 418),
    })

    const error = yield* Effect.flip(performanceProgram())

    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual login",
      status: 418,
    })
  }),
)

it.effect("fails on an unexpected finalize login status", () =>
  Effect.gen(function* () {
    createHttpScenario({
      signIn: response(""),
      login: response("{}", 201, "challenge=email"),
      finalizeLogin: response("{}", 503),
    })

    const error = yield* Effect.flip(performanceProgram())

    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual email 2FA",
      status: 503,
    })
  }),
)

it.effect("propagates cookies and browser headers through the authenticated session", () =>
  Effect.gen(function* () {
    const script = createHttpScenario({
      signIn: response("", 200, "session=sign-in; Path=/; Secure; HttpOnly"),
      login: response("{}", 200, "auth=direct; Path=/; Secure; HttpOnly"),
      reference: goalPerformanceResponse("2026-01-01", {}, "graph=reference; Path=/; Secure"),
      recent: goalPerformanceResponse("2026-07-01"),
    })

    yield* performanceProgram()

    expect(requestHeaders(script.byRoute.signIn).get("Cookie")).toBeNull()
    expect(requestHeaders(script.byRoute.login).get("Cookie")).toBe("session=sign-in")
    expect(requestHeaders(script.byRoute.reference).get("Cookie")).toBe(
      "session=sign-in; auth=direct",
    )
    expect(requestHeaders(script.byRoute.recent).get("Cookie")).toBe(
      "session=sign-in; auth=direct; graph=reference",
    )

    for (const request of script.requests) {
      expect(requestHeaders(request).get("User-Agent") ?? "").toMatch(/Mozilla\/5\.0/)
      expect(requestHeaders(request).get("Origin")).toBe("https://fintual.cl")
    }
  }),
)

it.effect.each([
  { scope: "default sign-in path", cookie: "session=sign-in", loginCookie: null },
  {
    scope: "explicit sign-in path",
    cookie: "session=sign-in; Path=/f/sign-in/",
    loginCookie: null,
  },
  {
    scope: "unrelated domain",
    cookie: "session=sign-in; Domain=example.com; Path=/",
    loginCookie: null,
  },
  {
    scope: "matching domain and root path",
    cookie: "session=sign-in; Domain=fintual.cl; Path=/; Secure",
    loginCookie: "session=sign-in",
  },
])("respects cookies scoped to $scope through email 2FA", ({ cookie, loginCookie }) =>
  Effect.gen(function* () {
    const script = createHttpScenario({
      signIn: response("", 200, cookie),
      login: response("{}", 201, "challenge=email; Path=/auth/sessions; Secure"),
      finalizeLogin: response("{}", 200, "auth=two-factor; Path=/; Secure; HttpOnly"),
      reference: goalPerformanceResponse("2026-01-01"),
      recent: goalPerformanceResponse("2026-07-01"),
    })

    yield* performanceProgram()

    expect(requestHeaders(script.byRoute.signIn).get("Cookie")).toBeNull()
    expect(requestHeaders(script.byRoute.login).get("Cookie")).toBe(loginCookie)
    expect(requestHeaders(script.byRoute.finalizeLogin).get("Cookie")).toBe(
      loginCookie === null ? "challenge=email" : `challenge=email; ${loginCookie}`,
    )
    for (const request of [script.byRoute.reference, script.byRoute.recent]) {
      expect(requestHeaders(request).get("Cookie")).toBe(
        loginCookie === null ? "auth=two-factor" : `${loginCookie}; auth=two-factor`,
      )
    }
  }),
)

describe("fails when Goal Performance Data is unavailable", () => {
  it.effect("reference request failure", () =>
    Effect.gen(function* () {
      createHttpScenario({
        signIn: response(""),
        login: response("{}"),
        reference: response("{}", 503),
      })

      const error = yield* Effect.flip(performanceProgram())

      expect(error).toMatchObject({
        _tag: "UnexpectedHttpStatus",
        stage: "Fintual reference Goal Performance Data",
        status: 503,
      })
    }),
  )

  it.effect("recent request failure", () =>
    Effect.gen(function* () {
      createHttpScenario({
        signIn: response(""),
        login: response("{}"),
        reference: goalPerformanceResponse("2026-01-01"),
        recent: response("{}", 503),
      })

      const error = yield* Effect.flip(performanceProgram())

      expect(error).toMatchObject({
        _tag: "UnexpectedHttpStatus",
        stage: "Fintual recent Goal Performance Data",
        status: 503,
      })
    }),
  )

  it.effect("malformed JSON in GraphQL response", () =>
    Effect.gen(function* () {
      createHttpScenario({
        signIn: response(""),
        login: response("{}"),
        reference: response("{"),
      })

      const error = yield* Effect.flip(performanceProgram())

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
      createHttpScenario({
        signIn: response(""),
        login: response("{}"),
        reference: response(
          JSON.stringify({
            ...goalPerformanceBody("2026-01-01"),
            errors: [{ message: "request failed" }],
          }),
        ),
      })

      const error = yield* Effect.flip(performanceProgram())

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
    }),
  )

  it.effect("invalid date in Goal Performance Data", () =>
    Effect.gen(function* () {
      const body = goalPerformanceBody("2026-02-31")
      createHttpScenario({
        signIn: response(""),
        login: response("{}"),
        reference: response(JSON.stringify(body)),
      })

      const error = yield* Effect.flip(performanceProgram())

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
      createHttpScenario({
        signIn: response(""),
        login: response("{}"),
        reference: response(body),
      })

      const error = yield* Effect.flip(performanceProgram())

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
    }),
  )
})

it.effect("fails with HttpTransportFailure when a request throws", () =>
  Effect.gen(function* () {
    const script = createHttpScenario({
      signIn: response(""),
      login: response("{}"),
      reference: HttpResponse.error(),
    })

    const error = yield* Effect.flip(performanceProgram())

    expect(error).toMatchObject({
      _tag: "HttpTransportFailure",
      stage: "Fintual reference Goal Performance Data",
    })
    expect(script.requests).toHaveLength(3)
    expect(script.byRoute.reference?.url).toBe("https://fintual.cl/gql/")
    expect(script.byRoute.recent).toBeUndefined()
  }),
)

it.effect("aborts the underlying fetch when its request fiber is interrupted", () =>
  Effect.gen(function* () {
    const requestStarted = stallSignIn()

    const fiber = yield* Effect.forkChild(performanceProgram())
    const request = yield* Effect.promise(() => requestStarted)
    yield* Fiber.interrupt(fiber)

    expect(request.signal.aborted).toBe(true)
  }),
)

it.effect("fails with HttpTransportFailure when request times out", () =>
  Effect.gen(function* () {
    const requestStarted = stallSignIn()

    const fiber = yield* Effect.forkChild(performanceProgram())
    const request = yield* Effect.promise(() => requestStarted)
    yield* TestClock.adjust(Duration.seconds(31))

    const error = yield* Effect.flip(Fiber.join(fiber))

    expect(error).toMatchObject({
      _tag: "HttpTransportFailure",
      stage: "Fintual sign-in page",
    })
    expect(request.signal.aborted).toBe(true)
  }),
)

it.effect("fails with MalformedPerformanceSnapshot when the fold output is invalid", () =>
  Effect.gen(function* () {
    const emptyPointsBody = { data: { balanceGraphDataPoints: [] } }
    createHttpScenario({
      signIn: response(""),
      login: response("{}"),
      reference: response(JSON.stringify(emptyPointsBody)),
      recent: response(JSON.stringify(emptyPointsBody)),
    })

    const error = yield* Effect.flip(performanceProgram())

    expect(error).toMatchObject({
      _tag: "MalformedPerformanceSnapshot",
    })
  }),
)

it.effect("starts with zero differences when reference does not precede the recent window", () =>
  Effect.gen(function* () {
    createHttpScenario({
      signIn: response("", 200, "session=sign-in"),
      login: response("{}", 200, "auth=direct"),
      reference: goalPerformanceResponse("2026-08-01", { costBasis: 800, valuation: 1000 }),
      recent: goalPerformanceResponse("2026-08-01", { costBasis: 850, valuation: 1100 }),
    })

    const snapshot = yield* performanceProgram()

    expect(snapshot).toEqual({
      balance: [{ date: Date.parse("2026-08-01"), value: 1100, difference: 0, real_difference: 0 }],
      deposits: [{ date: Date.parse("2026-08-01"), value: 850, difference: 0 }],
    })
  }),
)

it.effect("folds multiple reference and recent points into a Performance Snapshot", () =>
  Effect.gen(function* () {
    createHttpScenario({
      signIn: response("", 200, "session=sign-in"),
      login: response("{}", 200, "auth=direct"),
      reference: multiPointGoalPerformanceResponse([
        { date: "2026-07-30", costBasis: 800, valuation: 1000 },
      ]),
      recent: multiPointGoalPerformanceResponse([
        { date: "2026-08-01", costBasis: 850, valuation: 1100 },
        { date: "2026-08-02", costBasis: 900, valuation: 1150 },
      ]),
    })

    const snapshot = yield* performanceProgram()

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

      createHttpScenario({
        signIn: response("", 200, "session=sign-in"),
        login: response("{}", 200, "auth=direct"),
        reference: goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
        recent: goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
      })

      const error = yield* Effect.flip(performanceProgram())

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

function stallSignIn(): Promise<Request> {
  const started = Promise.withResolvers<Request>()
  server.use(
    http.get("https://fintual.cl/f/sign-in/", ({ request }) => {
      started.resolve(request)
      return new Promise<Response>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => resolve(new HttpResponse(null, { status: 499 })),
          {
            once: true,
          },
        )
      })
    }),
  )
  return started.promise
}

interface RecordedRequest {
  url: string
  init: RequestInit
}

type FintualRoute = "signIn" | "login" | "finalizeLogin" | "reference" | "recent"

function createHttpScenario(responses: Partial<Record<FintualRoute, Response>>) {
  const requests: RecordedRequest[] = []
  const byRoute: Partial<Record<FintualRoute, RecordedRequest>> = {}
  const respond = async (route: FintualRoute, request: Request): Promise<Response> => {
    const recorded = {
      url: request.url,
      init: {
        method: request.method,
        headers: request.headers,
        body: await request.clone().text(),
      },
    }
    requests.push(recorded)
    byRoute[route] = recorded
    const configuredResponse = responses[route]
    if (!configuredResponse) {
      throw new Error(`Unexpected Fintual route: ${route}`)
    }
    return configuredResponse.clone()
  }

  server.use(
    http.get("https://fintual.cl/f/sign-in/", ({ request }) => respond("signIn", request)),
    http.post("https://fintual.cl/auth/sessions/initiate_login", ({ request }) =>
      respond("login", request),
    ),
    http.post("https://fintual.cl/auth/sessions/finalize_login_web", ({ request }) =>
      respond("finalizeLogin", request),
    ),
    http.post<
      PathParams,
      { operationName: string; variables: { goalId: string; timeIntervalCode: string } }
    >("https://fintual.cl/gql/", async ({ request }) => {
      const body = await request.clone().json()
      expect(body.operationName).toBe("GoalInvestedBalanceGraphDataPoints")
      expect(body.variables.goalId).toBe(CONFIG.goalId)
      switch (body.variables.timeIntervalCode) {
        case "last_six_months":
          return respond("reference", request)
        case "last_month":
          return respond("recent", request)
        default:
          throw new Error(`Unexpected performance interval: ${body.variables.timeIntervalCode}`)
      }
    }),
  )

  return { requests, byRoute }
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
