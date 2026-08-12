import { inspect } from "node:util"
import { Context, Layer, Predicate, Redacted } from "effect"
import type { RuntimeConfig } from "./env.ts"

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

export class RedactionPolicy extends Context.Service<
  RedactionPolicy,
  {
    readonly redact: (value: string) => string
  }
>()("fintual-api/RedactionPolicy") {
  static readonly layer = (config: RuntimeConfig): Layer.Layer<RedactionPolicy, never, never> =>
    Layer.succeed(RedactionPolicy, RedactionPolicy.fromConfig(config))

  static readonly fromConfig = (config: RuntimeConfig): RedactionPolicy["Service"] =>
    RedactionPolicy.of({
      redact: (value) => redactSensitiveText(value, collectSensitiveValues(config)),
    })

  static readonly empty: RedactionPolicy["Service"] = RedactionPolicy.of({
    redact: (value) => redactSensitiveText(value, new Set()),
  })
}

function collectSensitiveValues(config: RuntimeConfig): ReadonlySet<string> {
  const email2FA = config.fintual.email2FA
  return new Set(
    [
      config.actual.serverUrl,
      Redacted.value(config.actual.password),
      config.actual.syncId,
      config.actual.fintualAccount,
      config.fintual.email,
      Redacted.value(config.fintual.password),
      config.fintual.goalId,
      email2FA?.userEmail,
      email2FA ? Redacted.value(email2FA.appPassword) : undefined,
    ].filter((value): value is string => Boolean(value)),
  )
}

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
