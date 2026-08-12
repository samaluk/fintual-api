import { Effect } from "effect"

import { main as mainActual } from "./actual.ts"
import type { ActualError } from "./actual.ts"
import { FintualConfigService, type RuntimeConfig } from "./env.ts"
import type { FintualError } from "./fintual/fintual-error.ts"
import { FintualPerformance } from "./fintual/performance.ts"

export const runJob = Effect.fn("Job.runJob")(function* (
  config: RuntimeConfig,
): Effect.fn.Return<void, ActualError | FintualError> {
  yield* Effect.logInfo("Running job...")
  const snapshot = yield* Effect.gen(function* () {
    const service = yield* FintualPerformance
    return yield* service.fetchPerformanceSnapshot
  }).pipe(
    Effect.provide(FintualPerformance.live),
    Effect.provideService(FintualConfigService, config.fintual),
  )
  yield* mainActual(config.actual, snapshot)
  yield* Effect.logInfo("Job finished.")
})
