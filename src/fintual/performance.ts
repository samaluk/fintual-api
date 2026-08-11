import { Context, Effect, Layer } from "effect"
import { FintualConfigService, type Email2FAConfig } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import {
  SnapshotWriter,
  validatePerformanceSnapshot,
  type PerformanceSnapshot,
} from "../performance-snapshot.ts"
import { FetchService, FINTUAL_ORIGIN } from "./authenticated-ingestion.ts"
import { Email2FAService } from "./email-2fa.ts"
import {
  HttpTransportFailure,
  Email2FAFailure,
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

const EMAIL_2FA_STAGE = "Fintual email 2FA"

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
          yield* authenticate(
            fetchService,
            email2FAService,
            config.email,
            config.password,
            config.email2FA,
          )

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
            Effect.try({
              try: () => foldGoalPerformanceData(reference, recent),
              catch: (cause) =>
                new Error(`Failed to fold Fintual performance data: ${getErrorMessage(cause)}`, {
                  cause,
                }),
            }),
            (cause) => new MalformedPerformanceSnapshot({ issues: getErrorMessage(cause) }),
          )

          const validatedSnapshot = yield* Effect.mapError(
            validatePerformanceSnapshot(snapshot),
            (cause) => new MalformedPerformanceSnapshot({ issues: cause.issues }),
          )
          yield* snapshotWriter.write(validatedSnapshot)

          return validatedSnapshot
        },
      )

      return FintualPerformance.of({ fetchPerformanceSnapshot })
    }),
  )

  static readonly live = FintualPerformance.layer.pipe(
    Layer.provide(FetchService.layer((input, init) => globalThis.fetch(input, init))),
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
  email2FAConfig: Email2FAConfig | null,
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

    if (!email2FAConfig) {
      return yield* new Email2FAFailure({
        stage: EMAIL_2FA_STAGE,
        cause: new Error("Fintual email 2FA: Gmail IMAP credentials not configured"),
      })
    }

    const code = yield* email2FAService
      .get2FACode(email2FAConfig, { afterTimestamp: new Date() })
      .pipe(
        Effect.catchTags({
          TimedOut: () =>
            Effect.fail(
              new Email2FAFailure({
                stage: EMAIL_2FA_STAGE,
                cause: new Error("Fintual email 2FA: no code received before timeout"),
              }),
            ),
          Operational: (failure) =>
            Effect.fail(new Email2FAFailure({ stage: EMAIL_2FA_STAGE, cause: failure.cause })),
        }),
      )

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
      EMAIL_2FA_STAGE,
    )
    yield* readResponseBody(finalizeResponse, EMAIL_2FA_STAGE)

    if (!finalizeResponse.ok) {
      return yield* failUnexpectedStatus(EMAIL_2FA_STAGE, finalizeResponse.status)
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
    Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new Error(`${stage}: failed to read response body: ${getErrorMessage(cause)}`, { cause }),
    }),
    (cause) => new HttpTransportFailure({ stage, cause }),
  )
}

function failUnexpectedStatus(stage: string, status: number): Effect.Effect<never, FintualError> {
  return Effect.fail(new UnexpectedHttpStatus({ stage, status }))
}
