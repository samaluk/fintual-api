import * as fs from "node:fs"
import { Effect } from "effect"
import * as v from "valibot"
import { log, trySync, warn } from "./effect.ts"
import { getErrorMessage } from "./log.ts"

const SNAPSHOT_DATA_DIR = "./tmp/fintual-data"
export const PERFORMANCE_SNAPSHOT_PATH = `${SNAPSHOT_DATA_DIR}/balance-2.json`

const finiteNumber = v.pipe(v.number(), v.finite())

const seriesPointSchema = v.object({
  date: finiteNumber,
  value: finiteNumber,
  difference: finiteNumber,
})

const performanceSnapshotSchema = v.object({
  balance: v.pipe(
    v.array(v.object({ ...seriesPointSchema.entries, real_difference: finiteNumber })),
    v.minLength(1),
  ),
  deposits: v.pipe(v.array(seriesPointSchema), v.minLength(1)),
})

export type PerformanceSnapshot = v.InferOutput<typeof performanceSnapshotSchema>

export function validatePerformanceSnapshot(
  snapshot: unknown,
): Effect.Effect<PerformanceSnapshot, Error> {
  return Effect.gen(function* () {
    const validation = v.safeParse(performanceSnapshotSchema, snapshot)
    if (!validation.success) {
      return yield* Effect.fail(
        new Error(
          `Fintual performance snapshot is invalid: ${JSON.stringify(v.flatten(validation.issues))}`,
        ),
      )
    }

    return validation.output
  })
}

export function writePerformanceSnapshot(snapshot: PerformanceSnapshot): Effect.Effect<void> {
  return Effect.matchEffect(
    trySync({
      try: () => {
        fs.mkdirSync(SNAPSHOT_DATA_DIR, { recursive: true })
        fs.writeFileSync(PERFORMANCE_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf-8")
      },
      catch: "Failed to write performance snapshot artifact",
    }),
    {
      onFailure: (cause) => warn(getErrorMessage(cause)),
      onSuccess: () => log(`Performance snapshot saved to ${PERFORMANCE_SNAPSHOT_PATH}`),
    },
  )
}
