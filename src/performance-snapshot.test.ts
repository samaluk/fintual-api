import * as fs from "node:fs"
import { Effect } from "effect"
import { expect, test } from "vitest"
import {
  PERFORMANCE_SNAPSHOT_PATH,
  validatePerformanceSnapshot,
  writePerformanceSnapshot,
  type PerformanceSnapshot,
} from "./performance-snapshot.ts"

test("rejects a balance entry with a non-finite date and reports the failing field", async () => {
  const invalidSnapshot = {
    ...performanceSnapshot(),
    balance: [{ date: Number.POSITIVE_INFINITY, value: 1100, difference: 50, real_difference: 50 }],
  }

  await expect(Effect.runPromise(validatePerformanceSnapshot(invalidSnapshot))).rejects.toThrow(
    /Fintual performance snapshot is invalid: .*balance/,
  )
})

test("rejects when deposits is not an array and reports the failing field", async () => {
  const invalidSnapshot = {
    ...performanceSnapshot(),
    deposits: {},
  }

  await expect(Effect.runPromise(validatePerformanceSnapshot(invalidSnapshot))).rejects.toThrow(
    /Fintual performance snapshot is invalid: .*deposits/,
  )
})

test("rejects an empty balance and reports the failing field", async () => {
  const invalidSnapshot = {
    ...performanceSnapshot(),
    balance: [],
  }

  await expect(Effect.runPromise(validatePerformanceSnapshot(invalidSnapshot))).rejects.toThrow(
    /Fintual performance snapshot is invalid: .*balance/,
  )
})

test("rejects an empty deposits and reports the failing field", async () => {
  const invalidSnapshot = {
    ...performanceSnapshot(),
    deposits: [],
  }

  await expect(Effect.runPromise(validatePerformanceSnapshot(invalidSnapshot))).rejects.toThrow(
    /Fintual performance snapshot is invalid: .*deposits/,
  )
})

test("returns the validated snapshot for valid data", async () => {
  const snapshot = performanceSnapshot()

  await expect(Effect.runPromise(validatePerformanceSnapshot(snapshot))).resolves.toEqual(snapshot)
})

test("writes a valid Performance Snapshot to the snapshot file", async () => {
  const originalContents = readSnapshotFileIfPresent()

  try {
    await Effect.runPromise(writePerformanceSnapshot(performanceSnapshot()))

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
