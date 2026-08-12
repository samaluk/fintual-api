import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
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
import { FintualConfigService, type FintualConfig } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import type { Email2FACode, Operational, TimedOut } from "./email-2fa.ts"
import {
  Email2FAFailure,
  HttpTransportFailure,
  LoginFailed,
  MalformedGoalPerformanceData,
  UnexpectedHttpStatus,
  type FintualError,
} from "./fintual-error.ts"

const FINTUAL_ORIGIN = "https://fintual.cl"
const HTTP_REQUEST_TIMEOUT_MS = 30_000
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const EMAIL_2FA_STAGE = "Fintual email 2FA"

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

const goalPerformanceDataResponseSchema = Schema.Struct({
  data: Schema.Struct({
    balanceGraphDataPoints: Schema.Array(goalPerformancePointSchema),
  }),
})

export type GoalPerformanceData = (typeof goalPerformanceDataResponseSchema.Type)["data"]

type RequestCode = (whenSignInBegan: Date) => Effect.Effect<Email2FACode, TimedOut | Operational>

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

const parseGoalPerformanceResponseBody = Effect.fn(
  "FintualProvider.parseGoalPerformanceResponseBody",
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

export class FintualProvider extends Context.Service<
  FintualProvider,
  {
    signIn: (requestCode: RequestCode) => Effect.Effect<void, FintualError>
    fetchReferenceGoalPerformanceData: Effect.Effect<GoalPerformanceData, FintualError>
    fetchRecentGoalPerformanceData: Effect.Effect<GoalPerformanceData, FintualError>
  }
>()("FintualProvider") {
  static readonly layer = Layer.effect(
    FintualProvider,
    Effect.gen(function* () {
      const config = yield* FintualConfigService
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

      return FintualProvider.of({
        signIn: Effect.fn("FintualProvider.signIn")(function* (requestCode: RequestCode) {
          yield* authenticate(session, config, requestCode)
        }),
        fetchReferenceGoalPerformanceData: fetchGoalPerformanceData(
          session,
          config.goalId,
          TimeIntervalCode.LastSixMonths,
          "reference",
        ).pipe(Effect.withSpan("FintualProvider.fetchReferenceGoalPerformanceData")),
        fetchRecentGoalPerformanceData: fetchGoalPerformanceData(
          session,
          config.goalId,
          TimeIntervalCode.LastMonth,
          "recent",
        ).pipe(Effect.withSpan("FintualProvider.fetchRecentGoalPerformanceData")),
      })
    }),
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "follow" })),
  )
}

const authenticate = Effect.fn("FintualProvider.authenticate")(function* (
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
    return yield* Effect.fail(new LoginFailed({ status: loginResponse.status }))
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

const loadSignInPage = Effect.fn("FintualProvider.loadSignInPage")(function* (
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

const fetchGoalPerformanceData = Effect.fn("FintualProvider.fetchGoalPerformanceData")(function* (
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
})

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
