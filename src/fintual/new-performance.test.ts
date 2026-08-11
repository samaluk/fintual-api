import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect, test } from "vitest"
import {
  createGoalPerformanceRequest,
  parseGoalPerformanceResponseBody,
  TimeIntervalCode,
} from "./new-performance.ts"

test("creates a Goal Performance Data request for the selected Fintual interval", () => {
  const request = createGoalPerformanceRequest("goal-123", TimeIntervalCode.LastSixMonths)

  expect(request.operationName).toBe("GoalInvestedBalanceGraphDataPoints")
  expect(request.variables).toEqual({
    goalId: "goal-123",
    timeIntervalCode: "last_six_months",
  })
})

it.effect("parses valid Goal Performance Data", () =>
  Effect.gen(function* () {
    const result = yield* parseGoalPerformanceResponseBody(
      JSON.stringify(goalPerformanceResponse()),
    )

    expect(result.balanceGraphDataPoints).toHaveLength(1)
    expect(result.balanceGraphDataPoints[0]?.date).toBe("2026-08-01")
  }),
)

it.effect("fails when the Goal Performance Data response is malformed JSON", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(parseGoalPerformanceResponseBody("{"))

    expect(error.message).toContain("Failed to parse goal performance response body")
  }),
)

it.effect("fails when the Goal Performance Data response has an invalid shape", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(parseGoalPerformanceResponseBody(JSON.stringify({ data: {} })))

    expect(error.message).toContain("response does not match the Goal Performance Data schema")
  }),
)

it.effect.each(["2026-13-45", "2026-02-31", "2025-02-29"])(
  "fails when a Goal Performance Data date is not a valid ISO date: %s",
  (date) =>
    Effect.gen(function* () {
      const response = goalPerformanceResponse()
      const point = response.data.balanceGraphDataPoints[0]
      if (!point) {
        throw new Error("expected a performance point")
      }
      point.date = date

      const error = yield* Effect.flip(parseGoalPerformanceResponseBody(JSON.stringify(response)))

      expect(error.message).toContain("response does not match the Goal Performance Data schema")
    }),
)

it.effect("fails when the GraphQL response contains errors", () =>
  Effect.gen(function* () {
    const response = {
      ...goalPerformanceResponse(),
      errors: [{ message: "request failed" }],
    }
    const body = JSON.stringify(response)

    const error = yield* Effect.flip(parseGoalPerformanceResponseBody(body))

    expect(error.message).toContain("GraphQL response contains errors")
  }),
)

it.effect("preserves non-finite wire amounts for snapshot validation", () =>
  Effect.gen(function* () {
    const response = goalPerformanceResponse()
    const body = JSON.stringify(response).replace(
      '"unrealizedCostBasisAmount":100',
      '"unrealizedCostBasisAmount":1e400',
    )

    const result = yield* parseGoalPerformanceResponseBody(body)

    expect(result.balanceGraphDataPoints[0]?.unrealizedCostBasisAmount).toBe(
      Number.POSITIVE_INFINITY,
    )
  }),
)

function goalPerformanceResponse(): {
  data: { balanceGraphDataPoints: Array<Record<string, unknown>> }
} {
  return {
    data: {
      balanceGraphDataPoints: [
        {
          date: "2026-08-01",
          unrealizedCostBasisAmount: 100,
          unrealizedGainOrLossAmount: 10,
          realizedCostBasisAmount: 90,
          realizedGainOrLossAmount: 5,
          sharesCostBasisAmount: 95,
          sharesValuationAmount: 110,
          pendingFulfillmentReinvestmentDepositsCostBasisAmount: 0,
          pendingFulfillmentReinvestmentDepositsAmount: 0,
          withdrawnAmount: 0,
        },
      ],
    },
  }
}
