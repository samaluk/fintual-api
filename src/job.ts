/** @effect-diagnostics lazyEffect:off */
import { Context, Effect, Layer } from "effect"

import { ActualSynchronization, type ActualError } from "./actual.ts"
import type { FintualError } from "./fintual/fintual-error.ts"
import { FintualPerformance } from "./fintual/performance.ts"

export type JobError = ActualError | FintualError

interface JobContract {
  synchronize(): Effect.Effect<void, JobError>
}

export class Job extends Context.Service<Job, JobContract>()("Job") {
  static readonly layer = Layer.effect(
    Job,
    Effect.gen(function* () {
      const fintual = yield* FintualPerformance
      const actual = yield* ActualSynchronization

      const synchronize = Effect.fn("Job.synchronize")(function* (): Effect.fn.Return<
        void,
        JobError
      > {
        yield* Effect.logInfo("Running job...")
        const snapshot = yield* fintual.fetchPerformanceSnapshot
        yield* actual.synchronize(snapshot)
        yield* Effect.logInfo("Job finished.")
      })

      return Job.of({ synchronize })
    }),
  )

  static readonly live = this.layer.pipe(
    Layer.provide(FintualPerformance.live),
    Layer.provide(ActualSynchronization.live),
  )
}
