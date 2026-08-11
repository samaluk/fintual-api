import { Effect } from "effect"
import { expect, test } from "vitest"
import { parsePerformanceSnapshot, type PerformanceSnapshot } from "./performance-snapshot.ts"

test("parses a valid Performance Snapshot", async () => {
  const result = await Effect.runPromise(
    parsePerformanceSnapshot(JSON.stringify(performanceSnapshot())),
  )

  expect(result.balance).toEqual([
    { date: 1780264800000, value: 1100, difference: 50, real_difference: 50 },
  ])
  expect(result.deposits).toEqual([{ date: 1780264800000, value: 850, difference: 50 }])
})

test("fails when the Performance Snapshot is malformed JSON", async () => {
  await expect(Effect.runPromise(parsePerformanceSnapshot("{"))).rejects.toThrow(
    "Failed to parse Fintual performance snapshot",
  )
})

test("fails when a balance entry is missing required fields", async () => {
  const invalidSnapshot = performanceSnapshot()
  const invalidBalanceEntry = {
    date: 1780264800000,
    value: 1100,
    difference: 50,
  }

  await expect(
    Effect.runPromise(
      parsePerformanceSnapshot(
        JSON.stringify({ ...invalidSnapshot, balance: [invalidBalanceEntry] }),
      ),
    ),
  ).rejects.toThrow("Fintual performance snapshot is invalid")
})

test("fails when deposits is not an array", async () => {
  const invalidSnapshot = performanceSnapshot()

  await expect(
    Effect.runPromise(
      parsePerformanceSnapshot(JSON.stringify({ ...invalidSnapshot, deposits: {} })),
    ),
  ).rejects.toThrow("Fintual performance snapshot is invalid")
})

function performanceSnapshot(): PerformanceSnapshot {
  return {
    balance: [{ date: 1780264800000, value: 1100, difference: 50, real_difference: 50 }],
    deposits: [{ date: 1780264800000, value: 850, difference: 50 }],
  }
}
