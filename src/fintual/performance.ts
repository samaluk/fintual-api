import { Context, Effect, Layer } from "effect"
import { tryPromise, trySync } from "../effect.ts"
import { FintualConfigService } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import {
  PerformanceSnapshotValidationError,
  SnapshotWriter,
  validatePerformanceSnapshot,
  type PerformanceSnapshot,
} from "../performance-snapshot.ts"
import { FetchService, FINTUAL_ORIGIN } from "./authenticated-ingestion.ts"
import { Email2FAService } from "./email-2fa.ts"
import {
  Email2FAFailure,
  HttpTransportFailure,
  LoginFailed,
  MalformedGoalPerformanceData,
  MalformedPerformanceSnapshot,
  UnexpectedHttpStatus,
  type FintualError,
} from "./fintual-error.ts"
import { foldGoalPerformanceData } from "./fold.ts"
import {
  createGoalPerformanceRequest,
  parseGoalPerformanceResponseBody,
  TimeIntervalCode,
  type GoalPerformanceData,
  type TimeIntervalCode as GoalPerformanceTimeInterval,
} from "./new-performance.ts"

const HTTP_2FA_EMAIL_TIMEOUT_MS = 120_000

export class FintualPerformance extends Context.Service<
  FintualPerformance,
  {
    fetchPerformanceSnapshot: () => Effect.Effect<PerformanceSnapshot, FintualError>
  }
>()("FintualPerformance") {
  static readonly layer = Layer.effect(
    FintualPerformance,
    Effect.gen(function* () {
      const config = yield* FintualConfigService
      const fetchService = yield* FetchService
      const email2FAService = yield* Email2FAService
      const snapshotWriter = yield* SnapshotWriter

      const fetchPerformanceSnapshot = Effect.fn("FintualPerformance.fetchPerformanceSnapshot")(
        function* () {
          yield* loadSignInPage(fetchService)
          yield* authenticate(fetchService, email2FAService, config.email, config.password)

          const reference = yield* fetchGoalPerformanceData(
            fetchService,
            config.goalId,
            TimeIntervalCode.LastSixMonths,
            "reference",
          )
          const recent = yield* fetchGoalPerformanceData(
            fetchService,
            config.goalId,
            TimeIntervalCode.LastMonth,
            "recent",
          )

          const snapshot = yield* Effect.mapError(
            trySync({
              try: () => foldGoalPerformanceData(reference, recent),
              catch: "Failed to fold Fintual performance data",
            }),
            (cause) => new MalformedPerformanceSnapshot({ issues: getErrorMessage(cause) }),
          )

          const validatedSnapshot = yield* Effect.catchIf(
            validatePerformanceSnapshot(snapshot),
            (error): error is PerformanceSnapshotValidationError =>
              error instanceof PerformanceSnapshotValidationError,
            (error) => Effect.fail(new MalformedPerformanceSnapshot({ issues: error.issues })),
          )
          yield* snapshotWriter.write(validatedSnapshot)

          return validatedSnapshot
        },
      )

      return FintualPerformance.of({ fetchPerformanceSnapshot })
    }),
  )

  static readonly live = FintualPerformance.layer.pipe(
    Layer.provide(FetchService.layer(globalThis.fetch)),
    Layer.provide(Email2FAService.layer),
    Layer.provide(SnapshotWriter.layer),
  )
}

function loadSignInPage(session: FetchService["Service"]): Effect.Effect<void, FintualError> {
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
  session: FetchService["Service"],
  email2FAService: Email2FAService["Service"],
  email: string,
  password: string,
): Effect.Effect<void, FintualError> {
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

    if (loginResponse.status === 401) {
      return yield* Effect.fail(new LoginFailed({ status: loginResponse.status }))
    }

    if (loginResponse.status !== 201) {
      return yield* failUnexpectedStatus("Fintual login", loginResponse.status)
    }

    const loginStartedAt = new Date()
    const code = yield* email2FAService.get2FACode({
      afterTimestamp: loginStartedAt,
      timeoutMs: HTTP_2FA_EMAIL_TIMEOUT_MS,
    })
    if (!code) {
      return yield* Effect.fail(
        new Email2FAFailure({
          cause: new Error("Fintual email 2FA: no code received before timeout"),
        }),
      )
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
  session: FetchService["Service"],
  goalId: string,
  timeInterval: GoalPerformanceTimeInterval,
  purpose: "reference" | "recent",
): Effect.Effect<GoalPerformanceData, FintualError> {
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
      (cause) => new MalformedGoalPerformanceData({ purpose, cause }),
    )
  })
}

function readResponseBody(response: Response, stage: string): Effect.Effect<string, FintualError> {
  return Effect.mapError(
    tryPromise({
      try: () => response.text(),
      catch: `${stage}: failed to read response body`,
    }),
    (cause) => new HttpTransportFailure({ stage, cause }),
  )
}

function failUnexpectedStatus(stage: string, status: number): Effect.Effect<never, FintualError> {
  return Effect.fail(new UnexpectedHttpStatus({ stage, status }))
}
