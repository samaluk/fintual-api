import * as fs from "node:fs"
import { Effect } from "effect"
import { trySync } from "../effect.ts"
import type { GoalPerformanceData } from "./new-performance.ts"

const FINTUAL_DATA_DIR = "./tmp/fintual-data"
export const BALANCE_FILE_PATH = `${FINTUAL_DATA_DIR}/balance-2.json`

export function foldGoalPerformanceData(
  sixMonthData: GoalPerformanceData | null,
  lastMonthData: GoalPerformanceData | null,
): { balance: unknown[]; deposits: unknown[] } | null {
  if (!lastMonthData?.balanceGraphDataPoints || !sixMonthData?.balanceGraphDataPoints) {
    return null
  }

  const lastMonthPoints = lastMonthData.balanceGraphDataPoints
  const previousDeposits = getPreviousValue(
    sixMonthData,
    lastMonthData,
    (point) => point.unrealizedCostBasisAmount,
  )
  const previousBalance = getPreviousValue(
    sixMonthData,
    lastMonthData,
    (point) => point.sharesValuationAmount,
  )

  const deposits = lastMonthPoints.map((point, index, points) => {
    const previousValue =
      index === 0 ? previousDeposits : points[index - 1].unrealizedCostBasisAmount

    return {
      date: Date.parse(point.date),
      value: point.unrealizedCostBasisAmount,
      difference: point.unrealizedCostBasisAmount - previousValue,
    }
  })

  const balance = lastMonthPoints.map((point, index, points) => {
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

export function writePerformanceFile(performanceData: {
  balance: unknown[]
  deposits: unknown[]
}): Effect.Effect<void, Error> {
  return trySync({
    try: () => {
      fs.mkdirSync(FINTUAL_DATA_DIR, { recursive: true })
      fs.writeFileSync(BALANCE_FILE_PATH, JSON.stringify(performanceData, null, 2), "utf-8")
    },
    catch: "Failed to write Fintual performance file",
  })
}
