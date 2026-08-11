import { pathToFileURL } from "node:url"
import { NodeRuntime } from "@effect/platform-node"
import { config as loadDotEnv } from "dotenv"
import { Array as EffectArray, Cause, Effect, Formatter, Logger, References } from "effect"
import { resolveRuntimeConfig, type RuntimeConfigError } from "./env.ts"
import type { ActualError } from "./actual.ts"
import type { FintualError } from "./fintual/fintual-error.ts"
import { runJob } from "./job.ts"
import { configureSensitiveValues, redactSensitiveText } from "./log.ts"

loadDotEnv()

const main: Effect.Effect<void, RuntimeConfigError | ActualError | FintualError> = Effect.gen(
  function* () {
    const runtimeConfig = yield* resolveRuntimeConfig(process.env)
    configureSensitiveValues(runtimeConfig)
    yield* Effect.logInfo("Running task once...")
    yield* runJob(runtimeConfig)
    yield* Effect.logInfo("Task completed.")
  },
)

export const redactingLogger = Logger.withLeveledConsole(
  Logger.make(({ cause, date, fiber, logLevel, message }) => {
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
    return redactSensitiveText(line)
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
  NodeRuntime.runMain(
    main.pipe(
      Effect.tapCause(reportUnhandledFailure),
      Effect.provide(Logger.layer([redactingLogger])),
    ),
    { disableErrorReporting: true },
  )
}
