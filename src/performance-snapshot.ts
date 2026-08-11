import * as fs from "node:fs"
import { Effect } from "effect"
import * as v from "valibot"
import { trySync } from "./effect.ts"

const SNAPSHOT_DATA_DIR = "./tmp/fintual-data"
export const PERFORMANCE_SNAPSHOT_PATH = `${SNAPSHOT_DATA_DIR}/balance-2.json`

const performanceSnapshotSchema = v.object({
  balance: v.array(
    v.object({
      date: v.number(),
      value: v.number(),
      difference: v.number(),
      real_difference: v.number(),
    }),
  ),
  deposits: v.array(
    v.object({
      date: v.number(),
      value: v.number(),
      difference: v.number(),
    }),
  ),
})

export type PerformanceSnapshot = v.InferOutput<typeof performanceSnapshotSchema>

export function parsePerformanceSnapshot(
  contents: string,
): Effect.Effect<PerformanceSnapshot, Error> {
  return Effect.gen(function* () {
    const parsedJson = yield* trySync({
      // oxlint-disable-next-line typescript/consistent-type-assertions
      try: () => JSON.parse(contents) as unknown,
      catch: "Failed to parse Fintual performance snapshot",
    })

    const validation = v.safeParse(performanceSnapshotSchema, parsedJson)
    if (!validation.success) {
      return yield* Effect.fail(new Error("Fintual performance snapshot is invalid"))
    }

    return validation.output
  })
}

export function readPerformanceSnapshot(): Effect.Effect<PerformanceSnapshot, Error> {
  return Effect.gen(function* () {
    const contents = yield* trySync({
      try: () => fs.readFileSync(PERFORMANCE_SNAPSHOT_PATH, "utf-8"),
      catch: "Failed to read Fintual performance snapshot file",
    })
    return yield* parsePerformanceSnapshot(contents)
  })
}

export function writePerformanceSnapshot(
  snapshot: PerformanceSnapshot,
): Effect.Effect<void, Error> {
  return trySync({
    try: () => {
      fs.mkdirSync(SNAPSHOT_DATA_DIR, { recursive: true })
      fs.writeFileSync(PERFORMANCE_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf-8")
    },
    catch: "Failed to write Fintual performance snapshot file",
  })
}
