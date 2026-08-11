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

test("parses valid Goal Performance Data", async () => {
  const result = await Effect.runPromise(
    parseGoalPerformanceResponseBody(JSON.stringify(goalPerformanceResponse())),
  )

  expect(result.balanceGraphDataPoints).toHaveLength(1)
  expect(result.balanceGraphDataPoints[0]?.date).toBe("2026-08-01")
})

test("fails when the Goal Performance Data response is malformed JSON", async () => {
  await expect(Effect.runPromise(parseGoalPerformanceResponseBody("{"))).rejects.toThrow(
    "Failed to parse goal performance response body",
  )
})

test("fails when the Goal Performance Data response has an invalid shape", async () => {
  await expect(
    Effect.runPromise(parseGoalPerformanceResponseBody(JSON.stringify({ data: {} }))),
  ).rejects.toThrow("response does not match the Goal Performance Data schema")
})

test("fails when the GraphQL response contains errors", async () => {
  await expect(
    Effect.runPromise(
      parseGoalPerformanceResponseBody(
        JSON.stringify({ ...goalPerformanceResponse(), errors: [{ message: "request failed" }] }),
      ),
    ),
  ).rejects.toThrow("GraphQL response contains errors")
})

test("preserves non-finite wire amounts for snapshot validation", async () => {
  const response = goalPerformanceResponse()
  const body = JSON.stringify(response).replace(
    '"unrealizedCostBasisAmount":100',
    '"unrealizedCostBasisAmount":1e400',
  )

  const result = await Effect.runPromise(parseGoalPerformanceResponseBody(body))

  expect(result.balanceGraphDataPoints[0]?.unrealizedCostBasisAmount).toBe(Number.POSITIVE_INFINITY)
})

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
