import { Effect, Result } from "effect"
import { expect, test } from "vitest"
import { resolveRuntimeConfig } from "./env.ts"

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

  expect(configuration).toEqual({
    actual: {
      serverUrl: "https://actual.example.test",
      password: "actual password",
      syncId: "sync-id",
      fintualAccount: "account-id",
      startingDate: "2024-03-01",
      payee: "Fintual",
    },
    fintual: {
      email: "investor@example.com",
      password: "fintual password",
      goalId: "goal-id",
      email2FA: null,
    },
  })
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
  expect(configuration.fintual.email2FA).toEqual({
    userEmail: "mailbox@example.com",
    appPassword: "app password",
    host: "mail.example.com",
    port: 1993,
    debug: true,
    sender: "security@example.com",
  })
})

test("reports all missing required runtime values", async () => {
  const result = await Effect.runPromise(Effect.result(resolveRuntimeConfig({})))

  expect(result._tag).toBe("Failure")
  if (Result.isFailure(result)) {
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
    expect(result.failure.message).toBe("Missing environment variables: GMAIL_APP_PASSWORD")
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
