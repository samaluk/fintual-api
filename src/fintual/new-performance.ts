import { Effect } from "effect"
import * as v from "valibot"
import { error, tryPromise, trySync } from "../effect.ts"
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

const newPerformanceSchema = v.object({
  data: v.object({
    balanceGraphDataPoints: v.array(
      v.object({
        date: v.pipe(v.string(), v.isoDate()),
        unrealizedCostBasisAmount: v.number(),
        unrealizedGainOrLossAmount: v.number(),
        realizedCostBasisAmount: v.number(),
        realizedGainOrLossAmount: v.number(),
        sharesCostBasisAmount: v.number(),
        sharesValuationAmount: v.number(),
        pendingFulfillmentReinvestmentDepositsCostBasisAmount: v.number(),
        pendingFulfillmentReinvestmentDepositsAmount: v.number(),
        withdrawnAmount: v.number(),
      }),
    ),
  }),
})

export type GoalPerformanceData = v.InferOutput<typeof newPerformanceSchema>["data"]

export function parseGoalPerformanceResponseBody(
  body: string,
): Effect.Effect<GoalPerformanceData, Error> {
  return Effect.gen(function* () {
    const parsedJson = yield* trySync({
      // oxlint-disable-next-line typescript/consistent-type-assertions
      try: () => JSON.parse(body) as unknown,
      catch: "Failed to parse goal performance response body",
    })

    const parsedData = v.safeParse(newPerformanceSchema, parsedJson)
    if (!parsedData.success) {
      return yield* Effect.fail(
        new Error(`Failed to validate goal performance data: ${getValidationFailure(parsedJson)}`),
      )
    }

    return parsedData.output.data
  })
}

function getValidationFailure(parsedJson: unknown): string {
  if (!isRecord(parsedJson)) {
    return "response is not an object"
  }

  if ("errors" in parsedJson) {
    return "GraphQL response contains errors"
  }

  return "response does not match the Goal Performance Data schema"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const GQL_URL = "https://fintual.cl/gql/"

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

/** GraphQL fetch using a raw `Cookie` header (see `docs/fintual-http-capture.md`). */
export function getGoalPerformanceWithCookies(
  cookieHeader: string,
  goalId: string,
  timeIntervalCode: TimeIntervalCode,
): Effect.Effect<GoalPerformanceData | null, Error> {
  return Effect.gen(function* () {
    const response = yield* tryPromise({
      try: () =>
        fetch(GQL_URL, {
          method: "POST",
          headers: {
            Accept: "*/*",
            "content-type": "application/json",
            Referer: "https://fintual.cl/",
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          body: JSON.stringify(createGoalPerformanceRequest(goalId, timeIntervalCode)),
        }),
      catch: "Failed to fetch goal performance data",
    })

    const body = yield* tryPromise({
      try: () => response.text(),
      catch: "Failed to read goal performance response body",
    })

    if (!response.ok) {
      yield* error(`Failed to fetch goal performance data (status ${response.status})`)
      return null
    }

    return yield* Effect.catchAll(parseGoalPerformanceResponseBody(body), (cause) =>
      Effect.as(error(getErrorMessage(cause)), null),
    )
  })
}
