import { Array as EffectArray, Cause, Effect, Formatter, Logger, References } from "effect"

import type { RedactionPolicy } from "./log.ts"

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
