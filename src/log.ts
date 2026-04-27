import { inspect } from "node:util"
import { normalizeEnvValue } from "./env.ts"

const SENSITIVE_ENV_NAMES = [
  "ACTUAL_PASSWORD",
  "ACTUAL_SERVER_URL",
  "ACTUAL_SYNC_ID",
  "ACTUAL_FINTUAL_ACCOUNT",
  "ACTUAL_PAYEE",
  "FINTUAL_USER_EMAIL",
  "FINTUAL_USER_PASSWORD",
  "FINTUAL_GOAL_ID",
  "GMAIL_USER_EMAIL",
  "GMAIL_APP_PASSWORD",
  "GMAIL_IMAP_HOST",
  "GMAIL_IMAP_PORT",
  "FINTUAL_2FA_SENDER",
  "FINTUAL_2FA_SUBJECT",
] as const

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return redactSensitiveText(error.message)
  }

  if (isRecord(error)) {
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

function redactSensitiveText(value: string): string {
  let redactedValue = value

  for (const envName of SENSITIVE_ENV_NAMES) {
    const envValue = getNormalizedEnvValue(envName)
    if (!envValue) {
      continue
    }

    redactedValue = redactedValue.split(envValue).join(`[redacted ${envName}]`)
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

function getNormalizedEnvValue(name: string): string {
  const value = process.env[name]
  if (!value) {
    return ""
  }

  return normalizeEnvValue(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
