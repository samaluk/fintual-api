import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"

import { ActualSynchronization } from "./actual.ts"
import { LoginFailed } from "./fintual/fintual-error.ts"
import { FintualPerformance } from "./fintual/performance.ts"
import { Job } from "./job.ts"
import type { PerformanceSnapshot } from "./performance-snapshot.ts"

const SNAPSHOT: PerformanceSnapshot = {
  balance: [{ date: 1, value: 100, difference: 5, real_difference: 5 }],
  deposits: [{ date: 1, value: 95, difference: 5 }],
}

it.effect("downloads before synchronizing and exposes the original domain failures", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const jobLayer = Job.layer.pipe(
      Layer.provide(
        Layer.succeed(FintualPerformance, {
          fetchPerformanceSnapshot: Effect.sync(() => {
            calls.push("fintual")
            return SNAPSHOT
          }),
        }),
      ),
      Layer.provide(
        Layer.succeed(ActualSynchronization, {
          synchronize: (snapshot) =>
            Effect.sync(() => {
              calls.push(`actual:${snapshot.balance.length}`)
            }),
        }),
      ),
    )

    const job = yield* Effect.service(Job).pipe(Effect.provide(jobLayer))
    yield* job.synchronize()

    expect(calls).toEqual(["fintual", "actual:1"])
  }),
)

it.effect("preserves a Fintual failure and does not start Actual", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const jobLayer = Job.layer.pipe(
      Layer.provide(
        Layer.succeed(FintualPerformance, {
          fetchPerformanceSnapshot: Effect.fail(new LoginFailed({ status: 401 })),
        }),
      ),
      Layer.provide(
        Layer.succeed(ActualSynchronization, {
          synchronize: () => Effect.sync(() => calls.push("actual")),
        }),
      ),
    )

    const job = yield* Effect.service(Job).pipe(Effect.provide(jobLayer))
    const error = yield* Effect.flip(job.synchronize())

    expect(error).toBeInstanceOf(LoginFailed)
    expect(calls).toEqual([])
  }),
)
