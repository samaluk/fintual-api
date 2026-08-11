import type { PerformanceSnapshot } from "../performance-snapshot.ts"
import type { GoalPerformanceData } from "./new-performance.ts"

export function foldGoalPerformanceData(
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
  selectValue: (point: GoalPerformanceData["balanceGraphDataPoints"][number]) => number,
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
