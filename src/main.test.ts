import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { expect } from "vitest"

import type { ActualError } from "./actual.ts"
import type { RuntimeConfig } from "./env.ts"
import type { FintualError } from "./fintual/fintual-error.ts"
import { runtimeConfig } from "./log-test-fixtures.ts"
import { RunJobService, runApplication, SchedulerService } from "./main.ts"
import type { SchedulerOptions } from "./scheduler.ts"

function runtimeConfigFor(mode: "once" | "schedule"): RuntimeConfig {
  return {
    ...runtimeConfig,
    schedule: {
      ...runtimeConfig.schedule,
      mode,
    },
  }
}

it.effect("runs exactly one synchronization attempt in once mode", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const job = Layer.succeed(RunJobService, {
      run: () => Ref.update(attempts, (n) => n + 1),
    })
    const scheduler = Layer.succeed(SchedulerService, {
      run: (_job: Effect.Effect<void, ActualError | FintualError>, _options: SchedulerOptions) =>
        Effect.never,
    })

    yield* runApplication(runtimeConfigFor("once")).pipe(
      Effect.provide(job.pipe(Layer.merge(scheduler))),
    )

    expect(yield* Ref.get(attempts)).toBe(1)
  }),
)

it.effect("delegates scheduled mode to the scheduler without running the job directly", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const scheduledOptions = yield* Ref.make<SchedulerOptions | null>(null)
    const attempts = yield* Ref.make(0)
    const schedulerCalled = yield* Deferred.make<void>()
    const scheduler = Layer.succeed(SchedulerService, {
      run: (_job: Effect.Effect<void, ActualError | FintualError>, options: SchedulerOptions) =>
        Ref.update(calls, (n) => n + 1).pipe(
          Effect.andThen(Ref.set(scheduledOptions, options)),
          Effect.andThen(Deferred.succeed(schedulerCalled, undefined)),
          Effect.andThen(Effect.never),
        ),
    })
    const job = Layer.succeed(RunJobService, {
      run: () => Ref.update(attempts, (n) => n + 1),
    })

    const config = runtimeConfigFor("schedule")
    const fiber = yield* Effect.forkChild(
      runApplication(config).pipe(Effect.provide(scheduler.pipe(Layer.merge(job)))),
    )
    yield* Deferred.await(schedulerCalled)

    expect(yield* Ref.get(attempts)).toBe(0)
    expect(yield* Ref.get(calls)).toBe(1)
    expect(yield* Ref.get(scheduledOptions)).toEqual(config.schedule)
    yield* Fiber.interrupt(fiber)
  }),
)
