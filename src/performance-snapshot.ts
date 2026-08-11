import * as fs from "node:fs"
import { Context, Effect, Layer, Schema } from "effect"
import * as v from "valibot"
import { getErrorMessage } from "./log.ts"
import { SnapshotWriteFailure } from "./fintual/fintual-error.ts"

const SNAPSHOT_DATA_DIR = "./tmp/fintual-data"
export const PERFORMANCE_SNAPSHOT_PATH = `${SNAPSHOT_DATA_DIR}/balance-2.json`

export class SnapshotWriter extends Context.Service<
  SnapshotWriter,
  {
    write: (snapshot: PerformanceSnapshot) => Effect.Effect<void, SnapshotWriteFailure>
  }
>()("SnapshotWriter") {
  static readonly layer = Layer.sync(SnapshotWriter, () =>
    SnapshotWriter.of({
      write: Effect.fn("SnapshotWriter.write")(function* (snapshot) {
        return yield* Effect.mapError(
          writePerformanceSnapshot(snapshot),
          (cause) => new SnapshotWriteFailure({ cause }),
        )
      }),
    }),
  )
}

class PerformanceSnapshotValidationError extends Schema.TaggedError<PerformanceSnapshotValidationError>()(
  "PerformanceSnapshotValidationError",
  {
    issues: Schema.String,
  },
) {
  get message(): string {
    return `Fintual performance snapshot is invalid: ${this.issues}`
  }
}

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
): Effect.Effect<PerformanceSnapshot, PerformanceSnapshotValidationError> {
  return Effect.gen(function* () {
    const validation = v.safeParse(performanceSnapshotSchema, snapshot)
    if (!validation.success) {
      return yield* Effect.fail(
        new PerformanceSnapshotValidationError({
          issues: JSON.stringify(v.flatten(validation.issues)),
        }),
      )
    }

    return validation.output
  })
}

export function writePerformanceSnapshot(
  snapshot: PerformanceSnapshot,
): Effect.Effect<void, Error> {
  return Effect.andThen(
    Effect.try({
      try: () => {
        fs.mkdirSync(SNAPSHOT_DATA_DIR, { recursive: true })
        fs.writeFileSync(PERFORMANCE_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf-8")
      },
      catch: (cause) =>
        new Error(`Failed to write performance snapshot artifact: ${getErrorMessage(cause)}`, {
          cause,
        }),
    }),
    () => Effect.logInfo(`Performance snapshot saved to ${PERFORMANCE_SNAPSHOT_PATH}`),
  )
}
