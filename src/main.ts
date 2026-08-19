import { pathToFileURL } from "node:url"

import { NodeRuntime } from "@effect/platform-node"
import { Effect, Option } from "effect"

import { runApplication } from "./app.ts"
import {
  ActualConfigService,
  Email2FAConfigService,
  FintualConfigService,
  ScheduleConfigService,
  type RuntimeConfigError,
  redactionSecrets,
  resolveRuntimeConfig,
} from "./env.ts"
import { Job, type JobError } from "./job.ts"
import { RedactingLogger, reportUnhandledFailure } from "./logging.ts"

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
    Effect.provide(Job.live),
    Effect.provideService(ActualConfigService, runtimeConfig.actual),
    Effect.provideService(FintualConfigService, runtimeConfig.fintual),
    Effect.provideService(
      Email2FAConfigService,
      runtimeConfig.email2FA ? Option.some(runtimeConfig.email2FA) : Option.none(),
    ),
    Effect.provideService(ScheduleConfigService, runtimeConfig.schedule),
    Effect.provide(RedactingLogger.layer(redactionSecrets(runtimeConfig))),
  )
})

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
}

if (isMainModule()) {
  NodeRuntime.runMain(main(), { disableErrorReporting: true })
}
