import * as fs from "node:fs"
import { Effect } from "effect"
import { expect, test } from "vitest"
import {
  PERFORMANCE_SNAPSHOT_PATH,
  writePerformanceSnapshot,
  type PerformanceSnapshot,
} from "./performance-snapshot.ts"

test("fails when a balance entry has a non-finite date", async () => {
  const invalidSnapshot = {
    ...performanceSnapshot(),
    balance: [{ date: Number.NaN, value: 1100, difference: 50, real_difference: 50 }],
  }

  await expect(Effect.runPromise(writePerformanceSnapshot(invalidSnapshot))).rejects.toThrow(
    "Fintual performance snapshot is invalid",
  )
})

test("fails when deposits is not an array", async () => {
  const invalidSnapshot = {
    ...performanceSnapshot(),
    deposits: {},
  }

  await expect(Effect.runPromise(writePerformanceSnapshot(invalidSnapshot))).rejects.toThrow(
    "Fintual performance snapshot is invalid",
  )
})

test("writes a valid Performance Snapshot to the snapshot file", async () => {
  const originalContents = readSnapshotFileIfPresent()

  try {
    const validatedSnapshot = await Effect.runPromise(
      writePerformanceSnapshot(performanceSnapshot()),
    )
    expect(validatedSnapshot).toEqual(performanceSnapshot())

    const writtenSnapshot: unknown = JSON.parse(fs.readFileSync(PERFORMANCE_SNAPSHOT_PATH, "utf-8"))
    expect(writtenSnapshot).toEqual(performanceSnapshot())
  } finally {
    restoreSnapshotFile(originalContents)
  }
})

function readSnapshotFileIfPresent(): string | null {
  if (!fs.existsSync(PERFORMANCE_SNAPSHOT_PATH)) {
    return null
  }

  return fs.readFileSync(PERFORMANCE_SNAPSHOT_PATH, "utf-8")
}

function restoreSnapshotFile(contents: string | null): void {
  if (contents === null) {
    fs.rmSync(PERFORMANCE_SNAPSHOT_PATH, { force: true })
    return
  }

  fs.writeFileSync(PERFORMANCE_SNAPSHOT_PATH, contents, "utf-8")
}

function performanceSnapshot(): PerformanceSnapshot {
  return {
    balance: [{ date: 1780264800000, value: 1100, difference: 50, real_difference: 50 }],
    deposits: [{ date: 1780264800000, value: 850, difference: 50 }],
  }
}
