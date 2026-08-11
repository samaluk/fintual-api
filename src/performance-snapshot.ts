import * as fs from "node:fs"
import { Effect } from "effect"
import * as v from "valibot"
import { trySync } from "./effect.ts"

const SNAPSHOT_DATA_DIR = "./tmp/fintual-data"
export const PERFORMANCE_SNAPSHOT_PATH = `${SNAPSHOT_DATA_DIR}/balance-2.json`

const finiteNumber = v.pipe(v.number(), v.finite())

const seriesPointSchema = v.object({
  date: finiteNumber,
  value: finiteNumber,
  difference: finiteNumber,
})

const performanceSnapshotSchema = v.object({
  balance: v.array(v.object({ ...seriesPointSchema.entries, real_difference: finiteNumber })),
  deposits: v.array(seriesPointSchema),
})

export type PerformanceSnapshot = v.InferOutput<typeof performanceSnapshotSchema>

export function writePerformanceSnapshot(
  snapshot: unknown,
): Effect.Effect<PerformanceSnapshot, Error> {
  return Effect.gen(function* () {
    const validation = v.safeParse(performanceSnapshotSchema, snapshot)
    if (!validation.success) {
      return yield* Effect.fail(new Error("Fintual performance snapshot is invalid"))
    }

    yield* trySync({
      try: () => {
        fs.mkdirSync(SNAPSHOT_DATA_DIR, { recursive: true })
        fs.writeFileSync(
          PERFORMANCE_SNAPSHOT_PATH,
          JSON.stringify(validation.output, null, 2),
          "utf-8",
        )
      },
      catch: "Failed to write Fintual performance snapshot file",
    })

    return validation.output
  })
}
