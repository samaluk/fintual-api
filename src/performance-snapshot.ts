import { Schema } from "effect"

const finiteNumber = Schema.Finite

const seriesPointSchema = Schema.Struct({
  date: finiteNumber,
  value: finiteNumber,
  difference: finiteNumber,
})

export const performanceSnapshotSchema = Schema.Struct({
  balance: Schema.Array(
    Schema.Struct({ ...seriesPointSchema.fields, real_difference: finiteNumber }),
  ).pipe(Schema.check(Schema.isNonEmpty())),
  deposits: Schema.Array(seriesPointSchema).pipe(Schema.check(Schema.isNonEmpty())),
})

export type PerformanceSnapshot = typeof performanceSnapshotSchema.Type
