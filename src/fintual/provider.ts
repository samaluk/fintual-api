import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect"
import { FintualConfigService, type FintualConfig } from "../env.ts"
import { getErrorMessage, revealSecret } from "../log.ts"
import type { Email2FACode, Operational, TimedOut } from "./email-2fa/retrieve.ts"
import {
  Email2FAFailure,
  HttpTransportFailure,
  LoginFailed,
  MalformedGoalPerformanceData,
  UnexpectedHttpStatus,
  type FintualError,
} from "./fintual-error.ts"

export const FINTUAL_ORIGIN = "https://fintual.cl"
const HTTP_REQUEST_TIMEOUT_MS = 30_000
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const EMAIL_2FA_STAGE = "Fintual email 2FA"

export const TimeIntervalCode = {
  LastMonth: "last_month",
  LastSixMonths: "last_six_months",
  LastYear: "last_year",
  LastThreeYears: "last_three_years",
  AllTime: "all_time",
} as const

export type TimeIntervalCode = (typeof TimeIntervalCode)[keyof typeof TimeIntervalCode]

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
  unrealizedCostBasisAmount: Schema.Number,
  unrealizedGainOrLossAmount: Schema.Number,
  realizedCostBasisAmount: Schema.Number,
  realizedGainOrLossAmount: Schema.Number,
  sharesCostBasisAmount: Schema.Number,
  sharesValuationAmount: Schema.Number,
  pendingFulfillmentReinvestmentDepositsCostBasisAmount: Schema.Number,
  pendingFulfillmentReinvestmentDepositsAmount: Schema.Number,
  withdrawnAmount: Schema.Number,
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

export const parseGoalPerformanceResponseBody = Effect.fn(
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

export function createGoalPerformanceRequest(
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
    fetchReferenceGoalPerformanceData: () => Effect.Effect<GoalPerformanceData, FintualError>
    fetchRecentGoalPerformanceData: () => Effect.Effect<GoalPerformanceData, FintualError>
  }
>()("FintualProvider") {
  static readonly layer = (
    fetch: typeof globalThis.fetch,
    options: { readonly requestTimeoutMs?: number } = {},
  ) =>
    Layer.effect(
      FintualProvider,
      Effect.gen(function* () {
        const config = yield* FintualConfigService
        const session = new FintualHttpSession(
          fetch,
          options.requestTimeoutMs ?? HTTP_REQUEST_TIMEOUT_MS,
        )

        return FintualProvider.of({
          signIn: Effect.fn("FintualProvider.signIn")(function* (requestCode: RequestCode) {
            yield* authenticate(session, config, requestCode)
          }),
          fetchReferenceGoalPerformanceData: Effect.fn(
            "FintualProvider.fetchReferenceGoalPerformanceData",
          )(function* () {
            return yield* fetchGoalPerformanceData(
              session,
              config.goalId,
              TimeIntervalCode.LastSixMonths,
              "reference",
            )
          }),
          fetchRecentGoalPerformanceData: Effect.fn(
            "FintualProvider.fetchRecentGoalPerformanceData",
          )(function* () {
            return yield* fetchGoalPerformanceData(
              session,
              config.goalId,
              TimeIntervalCode.LastMonth,
              "recent",
            )
          }),
        })
      }),
    )
}

export class FetchService extends Context.Service<
  FetchService,
  {
    request: (
      path: string,
      init: RequestInit,
      stage: string,
    ) => Effect.Effect<Response, FintualError>
  }
>()("FetchService") {
  static readonly layer = (
    fetch: typeof globalThis.fetch,
    options: { readonly requestTimeoutMs?: number } = {},
  ) =>
    Layer.sync(FetchService, () => {
      const session = new FintualHttpSession(
        fetch,
        options.requestTimeoutMs ?? HTTP_REQUEST_TIMEOUT_MS,
      )
      return FetchService.of({
        request: (path, init, stage) => session.request(path, init, stage),
      })
    })
}

const authenticate = Effect.fn("FintualProvider.authenticate")(function* (
  session: FintualHttpSession,
  config: FintualConfig,
  requestCode: (whenSignInBegan: Date) => Effect.Effect<Email2FACode, TimedOut | Operational>,
): Effect.fn.Return<void, FintualError> {
  yield* loadSignInPage(session)

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

const loadSignInPage = Effect.fn("FintualProvider.loadSignInPage")(function* (
  session: FintualHttpSession,
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

const fetchGoalPerformanceData = Effect.fn("FintualProvider.fetchGoalPerformanceData")(function* (
  session: FintualHttpSession,
  goalId: string,
  timeInterval: TimeIntervalCode,
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
})

const readResponseBody = Effect.fn("FintualProvider.readResponseBody")(function* (
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

class FintualHttpSession {
  private readonly cookies = new Map<string, string>()
  private readonly fetchRequest: typeof globalThis.fetch
  private readonly requestTimeoutMs: number

  constructor(fetchRequest: typeof globalThis.fetch, requestTimeoutMs: number) {
    this.fetchRequest = fetchRequest
    this.requestTimeoutMs = requestTimeoutMs
  }

  readonly request = Effect.fn("FintualHttpSession.request")(
    { self: this },
    function* (
      this: FintualHttpSession,
      path: string,
      init: RequestInit,
      stage: string,
    ): Effect.fn.Return<Response, FintualError> {
      const headers = new Headers(init.headers)
      headers.set("User-Agent", BROWSER_USER_AGENT)
      headers.set("Origin", FINTUAL_ORIGIN)

      const cookieHeader = [...this.cookies.values()].join("; ")
      if (cookieHeader) {
        headers.set("Cookie", cookieHeader)
      }

      const response = yield* Effect.tryPromise({
        try: (signal) =>
          this.fetchRequest(`${FINTUAL_ORIGIN}${path}`, {
            ...init,
            headers,
            signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
          }),
        catch: (cause) =>
          new HttpTransportFailure({
            stage,
            cause: new Error(`${stage}: request failed: ${getErrorMessage(cause)}`, { cause }),
          }),
      })

      yield* Effect.try({
        try: () => mergeSetCookieHeaders(response.headers, this.cookies),
        catch: (cause) =>
          new HttpTransportFailure({
            stage,
            cause: new Error(
              `${stage}: failed to update session cookies: ${getErrorMessage(cause)}`,
              { cause },
            ),
          }),
      })

      return response
    },
  )
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
