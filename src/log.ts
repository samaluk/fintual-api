import { inspect } from "node:util"

import { Context, Layer, Predicate } from "effect"

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

export class RedactionPolicy extends Context.Service<
  RedactionPolicy,
  {
    readonly redact: (value: string) => string
  }
>()("fintual-api/RedactionPolicy") {
  static readonly layer = (
    secrets: ReadonlyArray<string>,
  ): Layer.Layer<RedactionPolicy, never, never> =>
    Layer.succeed(RedactionPolicy, RedactionPolicy.fromConfig(secrets))

  static readonly fromConfig = (secrets: ReadonlyArray<string>): RedactionPolicy["Service"] => {
    const sensitiveValues = new Set(secrets)
    return RedactionPolicy.of({
      redact: (value) => redactSensitiveText(value, sensitiveValues),
    })
  }

  static readonly empty: RedactionPolicy["Service"] = (() => {
    const sensitiveValues = new Set<string>()
    return RedactionPolicy.of({
      redact: (value) => redactSensitiveText(value, sensitiveValues),
    })
  })()
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
