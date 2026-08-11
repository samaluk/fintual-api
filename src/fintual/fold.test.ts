import { expect, test } from "vitest"
import type { GoalPerformanceData } from "./provider.ts"
import { foldGoalPerformanceData } from "./fold.ts"

test("folds reference and recent Goal Performance Data into a Performance Snapshot", () => {
  const snapshot = foldGoalPerformanceData(
    performanceData([performancePoint("2026-07-30", { valuation: 1000, costBasis: 800 })]),
    performanceData([
      performancePoint("2026-08-01", { valuation: 1100, costBasis: 850 }),
      performancePoint("2026-08-02", { valuation: 1150, costBasis: 900 }),
    ]),
  )

  expect(snapshot).toEqual({
    balance: [
      { date: Date.parse("2026-08-01"), value: 1100, difference: 50, real_difference: 50 },
      { date: Date.parse("2026-08-02"), value: 1150, difference: 0, real_difference: 0 },
    ],
    deposits: [
      { date: Date.parse("2026-08-01"), value: 850, difference: 50 },
      { date: Date.parse("2026-08-02"), value: 900, difference: 50 },
    ],
  })
})

test("starts with zero differences when reference does not precede the recent window", () => {
  const snapshot = foldGoalPerformanceData(
    performanceData([performancePoint("2026-08-01", { valuation: 1000, costBasis: 800 })]),
    performanceData([performancePoint("2026-08-01", { valuation: 1100, costBasis: 850 })]),
  )

  expect(snapshot).toEqual({
    balance: [{ date: Date.parse("2026-08-01"), value: 1100, difference: 0, real_difference: 0 }],
    deposits: [{ date: Date.parse("2026-08-01"), value: 850, difference: 0 }],
  })
})

function performancePoint(
  date: string,
  options: { valuation?: number; costBasis?: number } = {},
): GoalPerformanceData["balanceGraphDataPoints"][number] {
  return {
    date,
    unrealizedCostBasisAmount: options.costBasis ?? 0,
    unrealizedGainOrLossAmount: 0,
    realizedCostBasisAmount: 0,
    realizedGainOrLossAmount: 0,
    sharesCostBasisAmount: 0,
    sharesValuationAmount: options.valuation ?? 0,
    pendingFulfillmentReinvestmentDepositsCostBasisAmount: 0,
    pendingFulfillmentReinvestmentDepositsAmount: 0,
    withdrawnAmount: 0,
  }
}

function performanceData(
  points: GoalPerformanceData["balanceGraphDataPoints"],
): GoalPerformanceData {
  return { balanceGraphDataPoints: points }
}
