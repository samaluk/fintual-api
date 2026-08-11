import { inspect } from "node:util"
import { Predicate, Redacted } from "effect"
import type { RuntimeConfig } from "./env.ts"

let configuredRedactionSecrets = new Set<string>()

export function configureSensitiveValues(config: RuntimeConfig): void {
  configuredRedactionSecrets = new Set(
    [
      config.actual.serverUrl,
      config.actual.syncId,
      config.actual.fintualAccount,
      config.fintual.email,
      config.fintual.goalId,
      config.fintual.email2FA?.userEmail,
    ].filter((value): value is string => Boolean(value)),
  )
}

export function revealSecret(secret: Redacted.Redacted<string>): string {
  const value = Redacted.value(secret)
  if (value) {
    configuredRedactionSecrets.add(value)
  }
  return value
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return redactSensitiveText(error.message)
  }

  if (Predicate.isObject(error)) {
    const structuredMessage = getStructuredErrorMessage(error)
    if (structuredMessage) {
      return redactSensitiveText(structuredMessage)
    }

    return redactSensitiveText(inspect(error, { depth: 3, breakLength: Number.POSITIVE_INFINITY }))
  }

  if (typeof error === "string" && error.trim()) {
    return redactSensitiveText(error)
  }

  return "Unknown error"
}

export function redactSensitiveText(value: string): string {
  let redactedValue = value

  for (const sensitiveValue of configuredRedactionSecrets) {
    redactedValue = redactedValue.split(sensitiveValue).join("[redacted]")
  }

  redactedValue = redactedValue.replaceAll(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[redacted email]",
  )

  return redactedValue
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
