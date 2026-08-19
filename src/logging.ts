import { inspect } from "node:util"

import {
  Array as EffectArray,
  Cause,
  Effect,
  Formatter,
  Layer,
  Logger,
  Predicate,
  References,
} from "effect"

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

export class RedactingLogger {
  static readonly layer = (secrets: ReadonlyArray<string>): Layer.Layer<never, never, never> =>
    Logger.layer([makeRedactingLogger(new Set(secrets))])

  static readonly empty: Layer.Layer<never, never, never> = Logger.layer([
    makeRedactingLogger(new Set()),
  ])
}

export const reportUnhandledFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause)

// Error rendering keeps the original cause evidence; redaction is applied once
// by the logging render edge so no construction path becomes a second boundary.
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  if (Predicate.isObject(error)) {
    const structuredMessage = getStructuredErrorMessage(error)
    if (structuredMessage) {
      return structuredMessage
    }

    return inspect(error, { depth: 3, breakLength: Number.POSITIVE_INFINITY })
  }

  if (typeof error === "string" && error.trim()) {
    return error
  }

  return "Unknown error"
}

function makeRedactingLogger(sensitiveValues: ReadonlySet<string>): Logger.Logger<unknown, void> {
  return Logger.withLeveledConsole(
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
      return redactSensitiveText(line, sensitiveValues)
    }),
  )
}

function redactSensitiveText(value: string, sensitiveValues: ReadonlySet<string>): string {
  let redactedValue = value

  for (const sensitiveValue of sensitiveValues) {
    redactedValue = redactedValue.split(sensitiveValue).join("[redacted]")
  }

  return redactedValue.replaceAll(EMAIL_PATTERN, "[redacted email]")
}

function getStructuredErrorMessage(error: Record<string, unknown>): string {
  const parts: string[] = []

  if (typeof error.type === "string" && error.type) {
    parts.push(error.type)
  }

  if (typeof error.reason === "string" && error.reason) {
    parts.push(error.reason)
  }

  if (typeof error.message === "string" && error.message) {
    parts.push(error.message)
  }

  return parts.join(": ")
}

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
