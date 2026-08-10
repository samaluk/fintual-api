import { Effect } from "effect"
import { tryPromise, trySync } from "../effect.ts"
import {
  createGoalPerformanceRequest,
  type GoalPerformanceData,
  parseGoalPerformanceResponseBody,
  TimeIntervalCode,
  type TimeIntervalCode as GoalPerformanceTimeInterval,
} from "./new-performance.ts"

const FINTUAL_ORIGIN = "https://fintual.cl"
const HTTP_2FA_EMAIL_TIMEOUT_MS = 120_000
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export interface AuthenticatedIngestionDependencies {
  fetch: typeof globalThis.fetch
  get2FACode: (options: {
    afterTimestamp: Date
    timeoutMs?: number
    pollIntervalMs?: number
  }) => Effect.Effect<string | null, Error>
}

export interface AuthenticatedIngestionOptions {
  email: string
  password: string
  goalId: string
}

export interface AuthenticatedGoalPerformanceData {
  reference: GoalPerformanceData
  recent: GoalPerformanceData
}

export type AuthenticatedFintualIngestion = (
  options: AuthenticatedIngestionOptions,
) => Effect.Effect<AuthenticatedGoalPerformanceData, Error>

export function createAuthenticatedFintualIngestion(
  dependencies: AuthenticatedIngestionDependencies,
): AuthenticatedFintualIngestion {
  return ({ email, password, goalId }) => {
    const session = new FintualHttpSession(dependencies.fetch)

    return Effect.gen(function* () {
      yield* loadSignInPage(session)
      yield* authenticate(session, dependencies.get2FACode, email, password)

      const reference = yield* fetchGoalPerformanceData(
        session,
        goalId,
        TimeIntervalCode.LastSixMonths,
        "reference",
      )
      const recent = yield* fetchGoalPerformanceData(
        session,
        goalId,
        TimeIntervalCode.LastMonth,
        "recent",
      )

      return { reference, recent }
    })
  }
}

class FintualHttpSession {
  private readonly cookies = new Map<string, string>()
  private readonly fetchRequest: typeof globalThis.fetch

  constructor(fetchRequest: typeof globalThis.fetch) {
    this.fetchRequest = fetchRequest
  }

  request(path: string, init: RequestInit, stage: string): Effect.Effect<Response, Error> {
    return Effect.gen(this, function* () {
      const headers = new Headers(init.headers)
      headers.set("User-Agent", BROWSER_USER_AGENT)
      headers.set("Origin", FINTUAL_ORIGIN)

      const cookieHeader = [...this.cookies.values()].join("; ")
      if (cookieHeader) {
        headers.set("Cookie", cookieHeader)
      }

      const response = yield* tryPromise({
        try: () => this.fetchRequest(`${FINTUAL_ORIGIN}${path}`, { ...init, headers }),
        catch: `${stage}: request failed`,
      })

      yield* trySync({
        try: () => mergeSetCookieHeaders(response.headers, this.cookies),
        catch: `${stage}: failed to update session cookies`,
      })

      return response
    })
  }
}

function loadSignInPage(session: FintualHttpSession): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const response = yield* session.request(
      "/f/sign-in/",
      {
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      "Fintual sign-in page",
    )

    yield* readResponseBody(response, "Fintual sign-in page")
  })
}

function authenticate(
  session: FintualHttpSession,
  get2FACode: AuthenticatedIngestionDependencies["get2FACode"],
  email: string,
  password: string,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const loginResponse = yield* session.request(
      "/auth/sessions/initiate_login",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Referer: `${FINTUAL_ORIGIN}/f/sign-in/`,
        },
        body: JSON.stringify({ email, password }),
      },
      "Fintual login",
    )
    yield* readResponseBody(loginResponse, "Fintual login")

    if (loginResponse.status === 200) {
      return
    }

    if (loginResponse.status !== 201) {
      return yield* failUnexpectedStatus("Fintual login", loginResponse.status)
    }

    const loginStartedAt = new Date()
    const code = yield* get2FACode({
      afterTimestamp: loginStartedAt,
      timeoutMs: HTTP_2FA_EMAIL_TIMEOUT_MS,
    })
    if (!code) {
      return yield* Effect.fail(new Error("Fintual email 2FA: no code received before timeout"))
    }

    const finalizeResponse = yield* session.request(
      "/auth/sessions/finalize_login_web",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Referer: `${FINTUAL_ORIGIN}/f/sign-in/`,
        },
        body: JSON.stringify({ email, password, code }),
      },
      "Fintual email 2FA",
    )
    yield* readResponseBody(finalizeResponse, "Fintual email 2FA")

    if (!finalizeResponse.ok) {
      return yield* failUnexpectedStatus("Fintual email 2FA", finalizeResponse.status)
    }
  })
}

function fetchGoalPerformanceData(
  session: FintualHttpSession,
  goalId: string,
  timeInterval: GoalPerformanceTimeInterval,
  purpose: "reference" | "recent",
): Effect.Effect<GoalPerformanceData, Error> {
  const stage = `Fintual ${purpose} Goal Performance Data`

  return Effect.gen(function* () {
    const response = yield* session.request(
      "/gql/",
      {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          Referer: `${FINTUAL_ORIGIN}/`,
        },
        body: JSON.stringify(createGoalPerformanceRequest(goalId, timeInterval)),
      },
      stage,
    )
    const body = yield* readResponseBody(response, stage)

    if (!response.ok) {
      return yield* failUnexpectedStatus(stage, response.status)
    }

    return yield* Effect.mapError(
      parseGoalPerformanceResponseBody(body),
      (cause) => new Error(`${stage}: validation failed`, { cause }),
    )
  })
}

function readResponseBody(response: Response, stage: string): Effect.Effect<string, Error> {
  return tryPromise({
    try: () => response.text(),
    catch: `${stage}: failed to read response body`,
  })
}

function failUnexpectedStatus(stage: string, status: number): Effect.Effect<never, Error> {
  return Effect.fail(new Error(`${stage}: unexpected HTTP status ${status}`))
}

function mergeSetCookieHeaders(headers: Headers, jar: Map<string, string>): void {
  for (const line of headers.getSetCookie?.() ?? []) {
    const namePart = line.split(";", 1)[0]?.trim()
    if (!namePart?.includes("=")) {
      continue
    }

    const separatorIndex = namePart.indexOf("=")
    jar.set(namePart.slice(0, separatorIndex), namePart)
  }
}
