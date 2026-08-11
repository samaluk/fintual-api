import { Effect, Redacted, Result } from "effect"
import { expect, test } from "vitest"
import { resolveRuntimeConfig, RuntimeConfigError } from "./env.ts"

function requiredEnvironment(): Record<string, string> {
  return {
    ACTUAL_SERVER_URL: " https://actual.example.test ",
    ACTUAL_PASSWORD: " 'actual password' ",
    ACTUAL_SYNC_ID: "sync-id",
    ACTUAL_FINTUAL_ACCOUNT: "account-id",
    FINTUAL_USER_EMAIL: '"investor@example.com"',
    FINTUAL_USER_PASSWORD: "fintual password",
    FINTUAL_GOAL_ID: "goal-id",
  }
}

test("normalizes runtime values and applies defaults once for every domain", async () => {
  const configuration = await Effect.runPromise(resolveRuntimeConfig(requiredEnvironment()))

  expect(configuration.actual).toMatchObject({
    serverUrl: "https://actual.example.test",
    syncId: "sync-id",
    fintualAccount: "account-id",
    startingDate: "2024-03-01",
    payee: "Fintual",
  })
  expect(configuration.fintual).toMatchObject({
    email: "investor@example.com",
    goalId: "goal-id",
    email2FA: null,
  })
  // Redacted intentionally exposes a safe placeholder through String().
  // oxlint-disable-next-line typescript/no-base-to-string
  expect(String(configuration.actual.password)).toBe("<redacted>")
  expect(Redacted.value(configuration.actual.password)).toBe("actual password")
  // oxlint-disable-next-line typescript/no-base-to-string
  expect(String(configuration.fintual.password)).toBe("<redacted>")
  expect(Redacted.value(configuration.fintual.password)).toBe("fintual password")
})

test("uses legacy starting date and enables email 2FA when both credentials are present", async () => {
  const configuration = await Effect.runPromise(
    resolveRuntimeConfig({
      ...requiredEnvironment(),
      STARTING_DATE: "2025-01-02",
      ACTUAL_PAYEE: "Investments",
      GMAIL_USER_EMAIL: "mailbox@example.com",
      GMAIL_APP_PASSWORD: "app password",
      GMAIL_IMAP_HOST: "mail.example.com",
      GMAIL_IMAP_PORT: "1993",
      GMAIL_IMAP_DEBUG: "TRUE",
      FINTUAL_2FA_SENDER: "security@example.com",
    }),
  )

  expect(configuration.actual.startingDate).toBe("2025-01-02")
  expect(configuration.actual.payee).toBe("Investments")
  expect(configuration.fintual.email2FA).not.toBeNull()
  if (configuration.fintual.email2FA) {
    expect(configuration.fintual.email2FA).toMatchObject({
      userEmail: "mailbox@example.com",
      host: "mail.example.com",
      port: 1993,
      debug: true,
      sender: "security@example.com",
    })
    // oxlint-disable-next-line typescript/no-base-to-string
    expect(String(configuration.fintual.email2FA.appPassword)).toBe("<redacted>")
    expect(Redacted.value(configuration.fintual.email2FA.appPassword)).toBe("app password")
  }
})

test("preserves quoted-empty values instead of falling back to defaults", async () => {
  const configuration = await Effect.runPromise(
    resolveRuntimeConfig({
      ...requiredEnvironment(),
      ACTUAL_PAYEE: "''",
      STARTING_DATE: "''",
    }),
  )

  expect(configuration.actual.payee).toBe("")
  expect(configuration.actual.startingDate).toBe("")
})

test("reports all missing required runtime values", async () => {
  const result = await Effect.runPromise(Effect.result(resolveRuntimeConfig({})))

  expect(result._tag).toBe("Failure")
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(RuntimeConfigError)
    expect(result.failure.cause).toBeDefined()
    expect(result.failure.message).toContain("ACTUAL_SERVER_URL")
  }
})

test("rejects partially configured email 2FA credentials", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        GMAIL_USER_EMAIL: "mailbox@example.com",
      }),
    ),
  )

  expect(result._tag).toBe("Failure")
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(RuntimeConfigError)
    expect(result.failure.message).toBe("Missing environment variables: GMAIL_APP_PASSWORD")
  }
})

test("rejects a Gmail app password without its user email", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        GMAIL_APP_PASSWORD: "app password",
      }),
    ),
  )

  expect(result._tag).toBe("Failure")
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(RuntimeConfigError)
    expect(result.failure.message).toBe("Missing environment variables: GMAIL_USER_EMAIL")
  }
})

test("preserves explicitly supplied empty Gmail credentials as present values", async () => {
  const configuration = await Effect.runPromise(
    resolveRuntimeConfig({
      ...requiredEnvironment(),
      GMAIL_USER_EMAIL: "",
      GMAIL_APP_PASSWORD: "",
    }),
  )

  expect(configuration.fintual.email2FA).not.toBeNull()
  if (configuration.fintual.email2FA) {
    expect(configuration.fintual.email2FA.userEmail).toBe("")
    expect(Redacted.value(configuration.fintual.email2FA.appPassword)).toBe("")
  }
})

test("rejects an invalid email 2FA port", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        GMAIL_USER_EMAIL: "mailbox@example.com",
        GMAIL_APP_PASSWORD: "app password",
        GMAIL_IMAP_PORT: "not-a-port",
      }),
    ),
  )

  expect(result._tag).toBe("Failure")
  if (Result.isFailure(result)) {
    expect(result.failure.message).toContain("GMAIL_IMAP_PORT")
  }
})

test("ignores email 2FA settings when automatic retrieval is disabled", async () => {
  const configuration = await Effect.runPromise(
    resolveRuntimeConfig({
      ...requiredEnvironment(),
      GMAIL_IMAP_PORT: "not-a-port",
    }),
  )

  expect(configuration.fintual.email2FA).toBeNull()
})
