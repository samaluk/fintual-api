import * as fs from "node:fs"

import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schema,
} from "effect"
import {
  Cookies,
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

import { Email2FAConfigService, FintualConfigService, type FintualConfig } from "../env.ts"
import { getErrorMessage } from "../logging.ts"
import { performanceSnapshotSchema, type PerformanceSnapshot } from "../performance-snapshot.ts"
import { Email2FACode, Email2FAService, Operational, TimedOut } from "./email-2fa.ts"
import {
  Email2FAFailure,
  HttpTransportFailure,
  LoginFailed,
  MalformedGoalPerformanceData,
  MalformedPerformanceSnapshot,
  SnapshotWriteFailure,
  UnexpectedHttpStatus,
  type FintualError,
} from "./fintual-error.ts"

const FINTUAL_ORIGIN = "https://fintual.cl"
const HTTP_REQUEST_TIMEOUT_MS = 30_000
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const EMAIL_2FA_STAGE = "Fintual email 2FA"

const SNAPSHOT_DATA_DIR = "./tmp/fintual-data"
export const PERFORMANCE_SNAPSHOT_PATH = `${SNAPSHOT_DATA_DIR}/balance-2.json`

const TimeIntervalCode = {
  LastMonth: "last_month",
  LastSixMonths: "last_six_months",
  LastYear: "last_year",
  LastThreeYears: "last_three_years",
  AllTime: "all_time",
} as const

type TimeIntervalCode = (typeof TimeIntervalCode)[keyof typeof TimeIntervalCode]

const GOAL_PERFORMANCE_QUERY =
  "query GoalInvestedBalanceGraphDataPoints($goalId: ID!, $timeIntervalCode: String!) {\n  balanceGraphDataPoints: clGoalBalanceGraphDataPoints(\n    goalId: $goalId\n    timeIntervalCode: $timeIntervalCode\n  ) {\n    date\n    unrealizedCostBasisAmount\n    unrealizedGainOrLossAmount\n    realizedCostBasisAmount\n    realizedGainOrLossAmount\n    sharesCostBasisAmount\n    sharesValuationAmount\n    pendingFulfillmentReinvestmentDepositsCostBasisAmount\n    pendingFulfillmentReinvestmentDepositsAmount\n    withdrawnAmount\n    __typename\n  }\n}"

const ISO_DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-([12]\d|0[1-9]|3[01])$/u

function isValidIsoDate(date: string): boolean {
  const match = ISO_DATE_PATTERN.exec(date)
  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const daysInMonth =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31

  return day <= daysInMonth
}

const goalPerformancePointSchema = Schema.Struct({
  date: Schema.String.pipe(
    Schema.check(Schema.isPattern(ISO_DATE_PATTERN)),
    Schema.check(
      Schema.makeFilter((date) => (isValidIsoDate(date) ? undefined : "a valid ISO calendar date")),
    ),
  ),
  unrealizedCostBasisAmount: Schema.Finite,
  unrealizedGainOrLossAmount: Schema.Finite,
  realizedCostBasisAmount: Schema.Finite,
  realizedGainOrLossAmount: Schema.Finite,
  sharesCostBasisAmount: Schema.Finite,
  sharesValuationAmount: Schema.Finite,
  pendingFulfillmentReinvestmentDepositsCostBasisAmount: Schema.Finite,
  pendingFulfillmentReinvestmentDepositsAmount: Schema.Finite,
  withdrawnAmount: Schema.Finite,
})

type GoalPerformancePoint = typeof goalPerformancePointSchema.Type

const goalPerformanceDataResponseSchema = Schema.Struct({
  data: Schema.Struct({
    balanceGraphDataPoints: Schema.Array(goalPerformancePointSchema),
  }),
})

type GoalPerformanceData = (typeof goalPerformanceDataResponseSchema.Type)["data"]

class InvalidGoalPerformanceResponse extends Schema.TaggedError<InvalidGoalPerformanceResponse>()(
  "InvalidGoalPerformanceResponse",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return getErrorMessage(this.cause)
  }
}

export class FintualPerformance extends Context.Service<
  FintualPerformance,
  {
    fetchPerformanceSnapshot: Effect.Effect<PerformanceSnapshot, FintualError>
  }
>()("FintualPerformance") {
  static readonly layer = Layer.effect(
    FintualPerformance,
    Effect.gen(function* () {
      const config = yield* FintualConfigService
      const email2FAService = yield* acquireEmail2FAService()
      const cookies = yield* Ref.make(Cookies.empty)
      const transport = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl(FINTUAL_ORIGIN),
            HttpClientRequest.setHeader("User-Agent", BROWSER_USER_AGENT),
            HttpClientRequest.setHeader("Origin", FINTUAL_ORIGIN),
          ),
        ),
        HttpClient.withCookiesRef(cookies),
      )
      const session = new FintualHttpSession(transport, Duration.millis(HTTP_REQUEST_TIMEOUT_MS))

      const fetchPerformanceSnapshot = Effect.gen(function* () {
        yield* authenticate(session, config, requestEmail2FACode(email2FAService))

        const reference = yield* fetchGoalPerformanceData(
          session,
          config.goalId,
          TimeIntervalCode.LastSixMonths,
          "reference",
        )
        const recent = yield* fetchGoalPerformanceData(
          session,
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

        const validatedSnapshot = yield* Schema.decodeEffect(performanceSnapshotSchema)(
          snapshot,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new MalformedPerformanceSnapshot({
                issues: cause.message.replace(/\s+/g, " ").trim(),
                cause,
              }),
          ),
        )
        yield* writePerformanceSnapshot(validatedSnapshot)

        return validatedSnapshot
      }).pipe(Effect.withSpan("FintualPerformance.fetchPerformanceSnapshot"))

      return FintualPerformance.of({ fetchPerformanceSnapshot })
    }),
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "follow" })),
  )

  static readonly live = Layer.unwrap(
    Effect.gen(function* () {
      yield* FintualConfigService
      const email2FAConfig = yield* Email2FAConfigService

      return FintualPerformance.layer.pipe(
        Layer.provide(Option.isSome(email2FAConfig) ? Email2FAService.live : Layer.empty),
      )
    }),
  )
}

const acquireEmail2FAService = Effect.fn("FintualPerformance.acquireEmail2FAService")(
  function* (): Effect.fn.Return<Option.Option<Email2FAService["Service"]>, never> {
    return yield* Effect.serviceOption(Email2FAService)
  },
)

const requestEmail2FACode =
  (
    email2FAService: Option.Option<Email2FAService["Service"]>,
  ): ((afterTimestamp: Date) => Effect.Effect<Email2FACode, TimedOut | Operational>) =>
  (afterTimestamp) =>
    Option.match(email2FAService, {
      onNone: () =>
        Effect.fail(
          new Operational({
            cause: new Error("Fintual email 2FA: Gmail IMAP credentials not configured"),
          }),
        ),
      onSome: (service) => service.get2FACode({ afterTimestamp }),
    })

const authenticate = Effect.fn("FintualPerformance.authenticate")(function* (
  session: FintualHttpSession,
  config: FintualConfig,
  requestCode: (whenSignInBegan: Date) => Effect.Effect<Email2FACode, TimedOut | Operational>,
): Effect.fn.Return<void, FintualError> {
  yield* loadSignInPage(session)

  const { response: loginResponse } = yield* session.request(
    "/auth/sessions/initiate_login",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: `${FINTUAL_ORIGIN}/f/sign-in/`,
      },
      body: JSON.stringify({ email: config.email, password: Redacted.value(config.password) }),
    },
    "Fintual login",
  )

  if (loginResponse.status === 200) {
    return
  }

  if (loginResponse.status === 401) {
    return yield* new LoginFailed({ status: loginResponse.status })
  }

  if (loginResponse.status !== 201) {
    return yield* failUnexpectedStatus("Fintual login", loginResponse.status)
  }

  const whenSignInBegan = yield* DateTime.now
  const code = yield* requestCode(DateTime.toDate(whenSignInBegan)).pipe(
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

  const { response: finalizeResponse } = yield* session.request(
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
        password: Redacted.value(config.password),
        code,
      }),
    },
    EMAIL_2FA_STAGE,
  )

  yield* Effect.mapError(
    HttpClientResponse.filterStatusOk(finalizeResponse),
    () => new UnexpectedHttpStatus({ stage: EMAIL_2FA_STAGE, status: finalizeResponse.status }),
  )
})

const loadSignInPage = Effect.fn("FintualPerformance.loadSignInPage")(function* (
  session: FintualHttpSession,
): Effect.fn.Return<void, FintualError> {
  yield* session.request(
    "/f/sign-in/",
    {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    },
    "Fintual sign-in page",
  )
})

const fetchGoalPerformanceData = Effect.fn("FintualPerformance.fetchGoalPerformanceData")(
  function* (
    session: FintualHttpSession,
    goalId: string,
    timeInterval: TimeIntervalCode,
    purpose: "reference" | "recent",
  ): Effect.fn.Return<GoalPerformanceData, FintualError> {
    const stage = `Fintual ${purpose} Goal Performance Data`

    const { response, body } = yield* session.request(
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

    yield* Effect.mapError(
      HttpClientResponse.filterStatusOk(response),
      () => new UnexpectedHttpStatus({ stage, status: response.status }),
    )

    return yield* Effect.mapError(
      parseGoalPerformanceResponseBody(body),
      (cause) => new MalformedGoalPerformanceData({ purpose, cause }),
    )
  },
)

const parseGoalPerformanceResponseBody = Effect.fn(
  "FintualPerformance.parseGoalPerformanceResponseBody",
)(function* (body: string): Effect.fn.Return<GoalPerformanceData, InvalidGoalPerformanceResponse> {
  const parsedJson = yield* Effect.try({
    // oxlint-disable-next-line typescript/consistent-type-assertions
    try: () => JSON.parse(body) as unknown,
    catch: (cause) =>
      new InvalidGoalPerformanceResponse({
        cause: new Error(
          `Failed to parse goal performance response body: ${getErrorMessage(cause)}`,
          { cause },
        ),
      }),
  })

  if (Predicate.isObject(parsedJson) && "errors" in parsedJson) {
    return yield* new InvalidGoalPerformanceResponse({
      cause: new Error(
        "Failed to validate goal performance data: GraphQL response contains errors",
      ),
    })
  }

  return yield* Schema.decodeUnknownEffect(goalPerformanceDataResponseSchema)(parsedJson).pipe(
    Effect.map((response) => response.data),
    Effect.mapError(
      (cause) =>
        new InvalidGoalPerformanceResponse({
          cause: new Error(
            `Failed to validate goal performance data: ${getValidationFailure(parsedJson)}`,
            { cause },
          ),
        }),
    ),
  )
})

function getValidationFailure(parsedJson: unknown): string {
  if (!Predicate.isObject(parsedJson)) {
    return "response is not an object"
  }

  return "response does not match the Goal Performance Data schema"
}

function createGoalPerformanceRequest(
  goalId: string,
  timeIntervalCode: TimeIntervalCode,
): Record<string, unknown> {
  return {
    operationName: "GoalInvestedBalanceGraphDataPoints",
    variables: {
      goalId,
      timeIntervalCode,
    },
    query: GOAL_PERFORMANCE_QUERY,
  }
}

function failUnexpectedStatus(stage: string, status: number): Effect.Effect<never, FintualError> {
  return Effect.fail(new UnexpectedHttpStatus({ stage, status }))
}

interface SessionRequestOptions {
  readonly method?: "GET" | "POST"
  readonly headers?: Record<string, string>
  readonly body?: string
}

interface SessionResponse {
  readonly response: HttpClientResponse.HttpClientResponse
  readonly body: string
}

function createSessionRequest(
  path: string,
  init: SessionRequestOptions,
): HttpClientRequest.HttpClientRequest {
  const request = HttpClientRequest.make(init.method ?? "GET")(path, { headers: init.headers })

  return init.body === undefined
    ? request
    : HttpClientRequest.setBody(
        request,
        HttpBody.raw(init.body, { contentType: "application/json" }),
      )
}

class FintualHttpSession {
  private readonly client: HttpClient.HttpClient
  private readonly requestTimeout: Duration.Duration

  constructor(client: HttpClient.HttpClient, requestTimeout: Duration.Duration) {
    this.client = client
    this.requestTimeout = requestTimeout
  }

  readonly request = Effect.fn("FintualHttpSession.request")(
    { self: this },
    function* (
      this: FintualHttpSession,
      path: string,
      init: SessionRequestOptions,
      stage: string,
    ): Effect.fn.Return<SessionResponse, FintualError> {
      const client = this.client
      const requestWithBody = Effect.gen(function* () {
        const response = yield* client.execute(createSessionRequest(path, init)).pipe(
          Effect.mapError(
            (cause) =>
              new HttpTransportFailure({
                stage,
                cause: new Error(`${stage}: request failed: ${getErrorMessage(cause)}`, { cause }),
              }),
          ),
        )
        const body = yield* Effect.mapError(
          response.text,
          (cause) =>
            new HttpTransportFailure({
              stage,
              cause: new Error(
                `${stage}: failed to read response body: ${getErrorMessage(cause)}`,
                {
                  cause,
                },
              ),
            }),
        )

        return { response, body }
      })

      return yield* requestWithBody.pipe(
        Effect.timeoutOrElse({
          duration: this.requestTimeout,
          orElse: () =>
            Effect.fail(
              new HttpTransportFailure({
                stage,
                cause: new Error(`${stage}: request timed out`),
              }),
            ),
        }),
      )
    },
  )
}

const writePerformanceSnapshot = Effect.fn("FintualPerformance.writeSnapshot")(function* (
  snapshot: PerformanceSnapshot,
): Effect.fn.Return<void, SnapshotWriteFailure> {
  return yield* Effect.andThen(
    Effect.try({
      try: () => {
        fs.mkdirSync(SNAPSHOT_DATA_DIR, { recursive: true })
        fs.writeFileSync(PERFORMANCE_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf-8")
      },
      catch: (cause) =>
        new SnapshotWriteFailure({
          cause: new Error(
            `Failed to write performance snapshot artifact: ${getErrorMessage(cause)}`,
            { cause },
          ),
        }),
    }),
    () => Effect.logInfo(`Performance snapshot saved to ${PERFORMANCE_SNAPSHOT_PATH}`),
  )
})

function foldGoalPerformanceData(
  referenceData: GoalPerformanceData,
  recentData: GoalPerformanceData,
): PerformanceSnapshot {
  const recentPoints = recentData.balanceGraphDataPoints
  const previousDeposits = getPreviousValue(
    referenceData,
    recentData,
    (point) => point.unrealizedCostBasisAmount,
  )
  const previousBalance = getPreviousValue(
    referenceData,
    recentData,
    (point) => point.sharesValuationAmount,
  )

  const deposits = recentPoints.map((point, index, points) => {
    const previousValue =
      index === 0 ? previousDeposits : points[index - 1].unrealizedCostBasisAmount

    return {
      date: Date.parse(point.date),
      value: point.unrealizedCostBasisAmount,
      difference: point.unrealizedCostBasisAmount - previousValue,
    }
  })

  const balance = recentPoints.map((point, index, points) => {
    const previousValue = index === 0 ? previousBalance : points[index - 1].sharesValuationAmount
    const previousDeposit =
      index === 0 ? previousDeposits : points[index - 1].unrealizedCostBasisAmount
    const deposit = point.unrealizedCostBasisAmount - previousDeposit
    const difference = point.sharesValuationAmount - previousValue - deposit

    return {
      date: Date.parse(point.date),
      value: point.sharesValuationAmount,
      difference,
      real_difference: difference,
    }
  })

  return { balance, deposits }
}

function getPreviousValue(
  baselineData: GoalPerformanceData,
  currentData: GoalPerformanceData,
  selectValue: (point: GoalPerformancePoint) => number,
): number {
  const currentPoints = currentData.balanceGraphDataPoints
  const firstDate = currentPoints[0]?.date
  if (!firstDate) {
    return 0
  }

  const previousPoint = [...baselineData.balanceGraphDataPoints]
    .filter((point) => point.date < firstDate)
    .sort((left, right) => right.date.localeCompare(left.date))[0]

  if (previousPoint) {
    return selectValue(previousPoint)
  }

  return selectValue(currentPoints[0])
}
