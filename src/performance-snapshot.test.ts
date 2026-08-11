import * as fs from "node:fs"
import * as path from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { getErrorMessage } from "./log.ts"
import {
  PERFORMANCE_SNAPSHOT_PATH,
  validatePerformanceSnapshot,
  writePerformanceSnapshot,
  type PerformanceSnapshot,
} from "./performance-snapshot.ts"

it.effect("rejects a balance entry with a non-finite date and reports the failing field", () =>
  Effect.gen(function* () {
    const invalidSnapshot = {
      ...performanceSnapshot(),
      balance: [
        { date: Number.POSITIVE_INFINITY, value: 1100, difference: 50, real_difference: 50 },
      ],
    }

    const error = yield* Effect.flip(validatePerformanceSnapshot(invalidSnapshot))

    expect(error.message).toMatch(/Fintual performance snapshot is invalid: .*balance/)
  }),
)

it.effect("rejects a deposit entry with a non-finite value and reports the failing field", () =>
  Effect.gen(function* () {
    const invalidSnapshot = {
      ...performanceSnapshot(),
      deposits: [{ date: 1780264800000, value: Number.NEGATIVE_INFINITY, difference: 50 }],
    }

    const error = yield* Effect.flip(validatePerformanceSnapshot(invalidSnapshot))

    expect(error.message).toMatch(/Fintual performance snapshot is invalid: .*deposits/)
  }),
)

it.effect("rejects when deposits is not an array and reports the failing field", () =>
  Effect.gen(function* () {
    const invalidSnapshot = {
      ...performanceSnapshot(),
      deposits: {},
    }

    const error = yield* Effect.flip(validatePerformanceSnapshot(invalidSnapshot))

    expect(error.message).toMatch(/Fintual performance snapshot is invalid: .*deposits/)
  }),
)

it.effect("rejects an empty balance and reports the failing field", () =>
  Effect.gen(function* () {
    const invalidSnapshot = {
      ...performanceSnapshot(),
      balance: [],
    }

    const error = yield* Effect.flip(validatePerformanceSnapshot(invalidSnapshot))

    expect(error.message).toMatch(/Fintual performance snapshot is invalid: .*balance/)
  }),
)

it.effect("rejects an empty deposits and reports the failing field", () =>
  Effect.gen(function* () {
    const invalidSnapshot = {
      ...performanceSnapshot(),
      deposits: [],
    }

    const error = yield* Effect.flip(validatePerformanceSnapshot(invalidSnapshot))

    expect(error.message).toMatch(/Fintual performance snapshot is invalid: .*deposits/)
  }),
)

it.effect("returns the validated snapshot for valid data", () =>
  Effect.gen(function* () {
    const snapshot = performanceSnapshot()

    const validated = yield* validatePerformanceSnapshot(snapshot)

    expect(validated).toEqual(snapshot)
  }),
)

it.effect("writes a valid Performance Snapshot to the snapshot file", () =>
  Effect.gen(function* () {
    const originalContents = readFileIfPresent(PERFORMANCE_SNAPSHOT_PATH)

    try {
      yield* writePerformanceSnapshot(performanceSnapshot())

      const writtenSnapshot: unknown = JSON.parse(
        fs.readFileSync(PERFORMANCE_SNAPSHOT_PATH, "utf-8"),
      )
      expect(writtenSnapshot).toEqual(performanceSnapshot())
    } finally {
      restoreFile(PERFORMANCE_SNAPSHOT_PATH, originalContents)
    }
  }),
)

it.effect("fails when the Performance Snapshot cannot be written", () =>
  Effect.gen(function* () {
    const snapshotPath = PERFORMANCE_SNAPSHOT_PATH
    const originalContents = readFileIfPresent(snapshotPath)
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })

    try {
      fs.mkdirSync(snapshotPath, { recursive: true })
      const error = yield* Effect.flip(writePerformanceSnapshot(performanceSnapshot()))

      expect(error).toMatchObject({ _tag: "SnapshotWriteFailure" })
      expect(getErrorMessage(error)).toContain("Failed to write performance snapshot artifact")
    } finally {
      fs.rmSync(snapshotPath, { force: true, recursive: true })
      restoreFile(snapshotPath, originalContents)
    }
  }),
)

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
