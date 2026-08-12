import { pathToFileURL } from "node:url"
import { NodeRuntime } from "@effect/platform-node"
import { config as loadDotEnv } from "dotenv"
import { Array as EffectArray, Cause, Effect, Formatter, Logger, References } from "effect"
import { resolveRuntimeConfig, type RuntimeConfig, type RuntimeConfigError } from "./env.ts"
import type { ActualError } from "./actual.ts"
import type { FintualError } from "./fintual/fintual-error.ts"
import { runJob } from "./job.ts"
import { RedactionPolicy } from "./log.ts"

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

export const makeRedactingLogger = (
  redactionPolicy: RedactionPolicy["Service"],
): Logger.Logger<unknown, void> =>
  Logger.withLeveledConsole(
    Logger.make<unknown, string>(({ cause, date, fiber, logLevel, message }) => {
      const parts: Array<string> = []
      for (const part of EffectArray.ensure(message)) {
        parts.push(renderPlain(part))
      }
      if (cause.reasons.length > 0) {
        parts.push(Cause.pretty(cause))
      }
      for (const [key, value] of Object.entries(fiber.getRef(References.CurrentLogAnnotations))) {
        parts.push(`${key}: ${renderPlain(value)}`)
      }
      const line = `[${formatTimestamp(date)}] ${logLevel.toUpperCase()}: ${parts.join(" ")}`
      return redactionPolicy.redact(line)
    }),
  )

export const reportUnhandledFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause)

function renderPlain(value: unknown): string {
  return typeof value === "string" ? value : Formatter.format(value)
}

function formatTimestamp(date: Date): string {
  const pad = (value: number, width: number): string => value.toString().padStart(width, "0")
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(
    date.getSeconds(),
    2,
  )}.${pad(date.getMilliseconds(), 3)}`
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
}

if (isMainModule()) {
  NodeRuntime.runMain(main(), { disableErrorReporting: true })
}
