import * as fs from "node:fs"
import * as path from "node:path"
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
  const originalContents = readFileIfPresent(PERFORMANCE_SNAPSHOT_PATH)

  try {
    await Effect.runPromise(writePerformanceSnapshot(performanceSnapshot()))

    const writtenSnapshot: unknown = JSON.parse(fs.readFileSync(PERFORMANCE_SNAPSHOT_PATH, "utf-8"))
    expect(writtenSnapshot).toEqual(performanceSnapshot())
  } finally {
    restoreFile(PERFORMANCE_SNAPSHOT_PATH, originalContents)
  }
})

test("fails when the Performance Snapshot cannot be written", async () => {
  const snapshotPath = PERFORMANCE_SNAPSHOT_PATH
  const originalContents = readFileIfPresent(snapshotPath)
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })

  try {
    fs.mkdirSync(snapshotPath, { recursive: true })
    await expect(
      Effect.runPromise(writePerformanceSnapshot(performanceSnapshot())),
    ).rejects.toThrow("Failed to write performance snapshot artifact")
  } finally {
    fs.rmSync(snapshotPath, { force: true, recursive: true })
    restoreFile(snapshotPath, originalContents)
  }
})

function readFileIfPresent(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null
  }

  return fs.readFileSync(filePath, "utf-8")
}

function restoreFile(filePath: string, contents: string | null): void {
  if (contents === null) {
    fs.rmSync(filePath, { force: true })
    return
  }

  fs.writeFileSync(filePath, contents, "utf-8")
}

function performanceSnapshot(): PerformanceSnapshot {
  return {
    balance: [{ date: 1780264800000, value: 1100, difference: 50, real_difference: 50 }],
    deposits: [{ date: 1780264800000, value: 850, difference: 50 }],
  }
}
