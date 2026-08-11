import { Effect, Predicate, Schema } from "effect"
import { getErrorMessage } from "../log.ts"

export const TimeIntervalCode = {
  LastMonth: "last_month",
  LastSixMonths: "last_six_months",
  LastYear: "last_year",
  LastThreeYears: "last_three_years",
  AllTime: "all_time",
} as const

export type TimeIntervalCode = (typeof TimeIntervalCode)[keyof typeof TimeIntervalCode]

const NEW_PERFORMANCE_QUERY =
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
    query: NEW_PERFORMANCE_QUERY,
  }
}
