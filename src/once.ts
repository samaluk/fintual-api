import { pathToFileURL } from "node:url"

import { NodeRuntime } from "@effect/platform-node"
import { config as loadDotEnv } from "dotenv"
import { Effect, Logger } from "effect"

import type { ActualError } from "./actual.ts"
import { resolveRuntimeConfig, type RuntimeConfig, type RuntimeConfigError } from "./env.ts"
import type { FintualError } from "./fintual/fintual-error.ts"
import { runJob } from "./job.ts"
import { RedactionPolicy } from "./log.ts"
import { makeRedactingLogger, reportUnhandledFailure } from "./logging.ts"

loadDotEnv()

const runOnce = Effect.fn("Once.runOnce")(function* (
  runtimeConfig: RuntimeConfig,
): Effect.fn.Return<void, ActualError | FintualError> {
  yield* Effect.logInfo("Running task once...")
  yield* runJob(runtimeConfig)
  yield* Effect.logInfo("Task completed.")
})

const main = Effect.fn("Once.main")(function* (): Effect.fn.Return<
  void,
  RuntimeConfigError | ActualError | FintualError
> {
  const runtimeConfig = yield* resolveRuntimeConfig(process.env).pipe(
    Effect.tapCause((cause) =>
      reportUnhandledFailure(cause).pipe(
        Effect.provide(Logger.layer([makeRedactingLogger(RedactionPolicy.empty)])),
      ),
    ),
  )
  yield* runOnce(runtimeConfig).pipe(
    Effect.tapCause(reportUnhandledFailure),
    Effect.provide(Logger.layer([makeRedactingLogger(RedactionPolicy.fromConfig(runtimeConfig))])),
  )
})

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
}

if (isMainModule()) {
  NodeRuntime.runMain(main(), { disableErrorReporting: true })
}
