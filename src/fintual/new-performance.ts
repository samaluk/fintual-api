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

type TimeIntervalCode = (typeof TimeIntervalCode)[keyof typeof TimeIntervalCode]

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

function parseGoalPerformanceJsonText(body: string): Effect.Effect<GoalPerformanceData | null> {
  return Effect.gen(function* () {
    const parsedJson = yield* Effect.catchAll(
      trySync({
        try: () => JSON.parse(body) as unknown,
        catch: "Failed to parse goal performance response body",
      }),
      (parseError) =>
        Effect.as(
          error(`Failed to parse goal performance response body: ${getErrorMessage(parseError)}`),
          null,
        ),
    )

    if (parsedJson === null) {
      return null
    }

    const parsedData = v.safeParse(newPerformanceSchema, parsedJson)
    if (!parsedData.success) {
      yield* error(
        `Failed to validate goal performance data: ${getValidationBodyPreview(parsedJson)}`,
      )
      return null
    }

    return parsedData.output.data
  })
}

function getValidationBodyPreview(parsedJson: unknown): string {
  if (!isRecord(parsedJson)) {
    return `unexpected response ${JSON.stringify(parsedJson).slice(0, 400)}`
  }

  if ("errors" in parsedJson) {
    return `GraphQL errors ${JSON.stringify(parsedJson.errors).slice(0, 400)}`
  }

  return `response preview ${JSON.stringify(parsedJson).slice(0, 400)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const GQL_URL = "https://fintual.cl/gql/"

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
          body: JSON.stringify({
            operationName: "GoalInvestedBalanceGraphDataPoints",
            variables: {
              goalId,
              timeIntervalCode,
            },
            query: NEW_PERFORMANCE_QUERY,
          }),
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

    return yield* parseGoalPerformanceJsonText(body)
  })
}
