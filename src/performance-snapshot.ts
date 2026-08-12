import * as fs from "node:fs"

import { Context, Effect, Layer, Schema } from "effect"

import { SnapshotWriteFailure } from "./fintual/fintual-error.ts"
import { getErrorMessage } from "./log.ts"

const SNAPSHOT_DATA_DIR = "./tmp/fintual-data"
export const PERFORMANCE_SNAPSHOT_PATH = `${SNAPSHOT_DATA_DIR}/balance-2.json`

export class SnapshotWriter extends Context.Service<
  SnapshotWriter,
  {
    write: (snapshot: PerformanceSnapshot) => Effect.Effect<void, SnapshotWriteFailure>
  }
>()("SnapshotWriter") {
  static readonly live = Layer.sync(SnapshotWriter, () =>
    SnapshotWriter.of({
      write: Effect.fn("SnapshotWriter.write")(function* (snapshot) {
        return yield* writePerformanceSnapshot(snapshot)
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
  override get message(): string {
    return `Fintual performance snapshot is invalid: ${this.issues}`
  }
}

const finiteNumber = Schema.Finite

const seriesPointSchema = Schema.Struct({
  date: finiteNumber,
  value: finiteNumber,
  difference: finiteNumber,
})

const performanceSnapshotSchema = Schema.Struct({
  balance: Schema.Array(
    Schema.Struct({ ...seriesPointSchema.fields, real_difference: finiteNumber }),
  ).pipe(Schema.check(Schema.isNonEmpty())),
  deposits: Schema.Array(seriesPointSchema).pipe(Schema.check(Schema.isNonEmpty())),
})

export type PerformanceSnapshot = typeof performanceSnapshotSchema.Type

export const validatePerformanceSnapshot = Effect.fn("PerformanceSnapshot.validate")(function* (
  snapshot: unknown,
): Effect.fn.Return<PerformanceSnapshot, PerformanceSnapshotValidationError> {
  return yield* Schema.decodeUnknownEffect(performanceSnapshotSchema)(snapshot).pipe(
    Effect.mapError(
      (cause) =>
        new PerformanceSnapshotValidationError({
          issues: cause.message.replace(/\s+/g, " ").trim(),
        }),
    ),
  )
})

export const writePerformanceSnapshot = Effect.fn("PerformanceSnapshot.write")(function* (
  snapshot: PerformanceSnapshot,
): Effect.fn.Return<void, SnapshotWriteFailure> {
  return yield* Effect.andThen(
    Effect.try({
      try: () => {
        fs.mkdirSync(SNAPSHOT_DATA_DIR, { recursive: true })
        fs.writeFileSync(PERFORMANCE_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf-8")
      },
      catch: (cause) =>
        new SnapshotWriteFailure({
          cause: new Error(
            `Failed to write performance snapshot artifact: ${getErrorMessage(cause)}`,
            { cause },
          ),
        }),
    }),
    () => Effect.logInfo(`Performance snapshot saved to ${PERFORMANCE_SNAPSHOT_PATH}`),
  )
})
