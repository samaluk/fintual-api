import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import {
  createGoalPerformanceRequest,
  parseGoalPerformanceResponseBody,
  TimeIntervalCode,
} from "./new-performance.ts"

void test("creates a Goal Performance Data request for the selected Fintual interval", () => {
  const request = createGoalPerformanceRequest("goal-123", TimeIntervalCode.LastSixMonths)

  assert.equal(request.operationName, "GoalInvestedBalanceGraphDataPoints")
  assert.deepEqual(request.variables, {
    goalId: "goal-123",
    timeIntervalCode: "last_six_months",
  })
})

void test("parses valid Goal Performance Data", async () => {
  const result = await Effect.runPromise(
    parseGoalPerformanceResponseBody(JSON.stringify(goalPerformanceResponse())),
  )

  assert.equal(result.balanceGraphDataPoints.length, 1)
  assert.equal(result.balanceGraphDataPoints[0]?.date, "2026-08-01")
})

void test("fails when the Goal Performance Data response is malformed JSON", async () => {
  await assert.rejects(
    Effect.runPromise(parseGoalPerformanceResponseBody("{")),
    /Failed to parse goal performance response body/,
  )
})

void test("fails when the Goal Performance Data response has an invalid shape", async () => {
  await assert.rejects(
    Effect.runPromise(parseGoalPerformanceResponseBody(JSON.stringify({ data: {} }))),
    /response does not match the Goal Performance Data schema/,
  )
})

function goalPerformanceResponse(): Record<string, unknown> {
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
