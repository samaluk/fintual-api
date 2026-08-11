import { Context, DateTime, Effect, Layer } from "effect"
import { FintualConfigService, type FintualConfig } from "../env.ts"
import { getErrorMessage, revealSecret } from "../log.ts"
import {
  SnapshotWriter,
  validatePerformanceSnapshot,
  type PerformanceSnapshot,
} from "../performance-snapshot.ts"
import { FetchService, FINTUAL_ORIGIN } from "./authenticated-ingestion.ts"
import { Email2FAService, EMAIL_2FA_CONFIG_MISSING_MESSAGE } from "./email-2fa.ts"
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
          yield* authenticate(fetchService, email2FAService, config)

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

          const snapshot = yield* Effect.try({
            try: () => foldGoalPerformanceData(reference, recent),
            catch: (cause) =>
              new MalformedPerformanceSnapshot({
                issues: `Failed to fold Fintual performance data: ${getErrorMessage(cause)}`,
                cause,
              }),
          })

          const validatedSnapshot = yield* Effect.mapError(
            validatePerformanceSnapshot(snapshot),
            (cause) => new MalformedPerformanceSnapshot({ issues: cause.issues, cause }),
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
    Layer.provide(Email2FAService.live),
    Layer.provide(SnapshotWriter.layer),
  )
}

const loadSignInPage = Effect.fn("FintualPerformance.loadSignInPage")(function* (
  session: FetchService["Service"],
): Effect.fn.Return<void, FintualError> {
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

const authenticate = Effect.fn("FintualPerformance.authenticate")(function* (
  session: FetchService["Service"],
  email2FAService: Email2FAService["Service"],
  config: FintualConfig,
): Effect.fn.Return<void, FintualError> {
  const loginResponse = yield* session.request(
    "/auth/sessions/initiate_login",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: `${FINTUAL_ORIGIN}/f/sign-in/`,
      },
      body: JSON.stringify({ email: config.email, password: revealSecret(config.password) }),
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

  if (!config.email2FA) {
    return yield* new Email2FAFailure({
      stage: EMAIL_2FA_STAGE,
      cause: new Error(EMAIL_2FA_CONFIG_MISSING_MESSAGE),
    })
  }

  const loginStartedAt = yield* DateTime.now
  const code = yield* email2FAService
    .get2FACode({ afterTimestamp: DateTime.toDate(loginStartedAt) })
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
      body: JSON.stringify({
        email: config.email,
        password: revealSecret(config.password),
        code,
      }),
    },
    EMAIL_2FA_STAGE,
  )
  yield* readResponseBody(finalizeResponse, EMAIL_2FA_STAGE)

  if (!finalizeResponse.ok) {
    return yield* failUnexpectedStatus(EMAIL_2FA_STAGE, finalizeResponse.status)
  }
})

const fetchGoalPerformanceData = Effect.fn("FintualPerformance.fetchGoalPerformanceData")(
  function* (
    session: FetchService["Service"],
    goalId: string,
    timeInterval: GoalPerformanceTimeInterval,
    purpose: "reference" | "recent",
  ): Effect.fn.Return<GoalPerformanceData, FintualError> {
    const stage = `Fintual ${purpose} Goal Performance Data`

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
  },
)

const readResponseBody = Effect.fn("FintualPerformance.readResponseBody")(function* (
  response: Response,
  stage: string,
): Effect.fn.Return<string, FintualError> {
  return yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new HttpTransportFailure({
        stage,
        cause: new Error(`${stage}: failed to read response body: ${getErrorMessage(cause)}`, {
          cause,
        }),
      }),
  })
})

function failUnexpectedStatus(stage: string, status: number): Effect.Effect<never, FintualError> {
  return Effect.fail(new UnexpectedHttpStatus({ stage, status }))
}
