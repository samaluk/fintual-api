import { pathToFileURL } from "node:url"

import { NodeRuntime } from "@effect/platform-node"
import { config as loadDotEnv } from "dotenv"
import { Context, Effect, Layer, Logger } from "effect"

import type { ActualError } from "./actual.ts"
import { resolveRuntimeConfig, type RuntimeConfig, type RuntimeConfigError } from "./env.ts"
import type { FintualError } from "./fintual/fintual-error.ts"
import { runJob } from "./job.ts"
import { RedactionPolicy } from "./log.ts"
import { makeRedactingLogger, reportUnhandledFailure } from "./logging.ts"
import { InvalidScheduleError, runScheduler, type SchedulerOptions } from "./scheduler.ts"

type RunApplicationError = ActualError | FintualError | InvalidScheduleError

loadDotEnv()

export class RunJobService extends Context.Service<
  RunJobService,
  {
    readonly run: (config: RuntimeConfig) => Effect.Effect<void, ActualError | FintualError>
  }
>()("RunJobService") {
  static readonly live = Layer.succeed(
    RunJobService,
    RunJobService.of({
      run: (config) => runJob(config),
    }),
  )
}

export class SchedulerService extends Context.Service<
  SchedulerService,
  {
    readonly run: (
      job: Effect.Effect<void, ActualError | FintualError>,
      options: SchedulerOptions,
    ) => Effect.Effect<never, InvalidScheduleError>
  }
>()("SchedulerService") {
  static readonly live = Layer.succeed(
    SchedulerService,
    SchedulerService.of({
      run: (job, options) => runScheduler(job, options),
    }),
  )
}

export const runApplication = Effect.fn("Main.runApplication")(function* (
  runtimeConfig: RuntimeConfig,
): Effect.fn.Return<void, RunApplicationError, RunJobService | SchedulerService> {
  if (runtimeConfig.schedule.mode === "schedule") {
    const scheduler = yield* SchedulerService
    return yield* scheduler.run(runJob(runtimeConfig), runtimeConfig.schedule)
  }

  const job = yield* RunJobService
  yield* job.run(runtimeConfig)
})

const main = Effect.fn("Main.main")(function* (): Effect.fn.Return<
  void,
  RuntimeConfigError | RunApplicationError
> {
  const runtimeConfig = yield* resolveRuntimeConfig(process.env).pipe(
    Effect.tapCause((cause) =>
      reportUnhandledFailure(cause).pipe(
        Effect.provide(Logger.layer([makeRedactingLogger(RedactionPolicy.empty)])),
      ),
    ),
  )
  yield* runApplication(runtimeConfig).pipe(
    Effect.tapCause(reportUnhandledFailure),
    Effect.provide(
      RunJobService.live.pipe(
        Layer.merge(SchedulerService.live),
        Layer.merge(Logger.layer([makeRedactingLogger(RedactionPolicy.fromConfig(runtimeConfig))])),
      ),
    ),
  )
})

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
}

if (isMainModule()) {
  NodeRuntime.runMain(main(), { disableErrorReporting: true })
}
