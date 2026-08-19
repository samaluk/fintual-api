import { pathToFileURL } from "node:url"

import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"

import {
  ScheduleConfigService,
  type RuntimeConfigError,
  resolveRuntimeConfig,
  runtimeLayer,
} from "./env.ts"
import { Job, type JobError } from "./job.ts"
import { RedactingLogger, reportUnhandledFailure } from "./logging.ts"
import { runScheduler } from "./scheduler.ts"

export const runApplication = Effect.fn("Main.runApplication")(function* (): Effect.fn.Return<
  void,
  JobError,
  ScheduleConfigService | Job
> {
  const schedule = yield* ScheduleConfigService
  const job = yield* Job

  if (schedule.mode === "schedule") {
    return yield* runScheduler(job.synchronize(), schedule)
  }

  yield* Effect.logInfo("Running task once...")
  yield* job.synchronize()
  yield* Effect.logInfo("Task completed.")
})

const main = Effect.fn("Main.main")(function* (): Effect.fn.Return<
  void,
  RuntimeConfigError | JobError
> {
  const runtimeConfig = yield* resolveRuntimeConfig().pipe(
    Effect.tapCause((cause) =>
      reportUnhandledFailure(cause).pipe(Effect.provide(RedactingLogger.empty)),
    ),
  )

  yield* runApplication().pipe(
    Effect.tapCause(reportUnhandledFailure),
    Effect.provide(Job.live.pipe(Layer.provideMerge(runtimeLayer(runtimeConfig)))),
  )
})

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
}

if (isMainModule()) {
  NodeRuntime.runMain(main(), { disableErrorReporting: true })
}
