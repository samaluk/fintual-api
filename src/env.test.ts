import { it } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"
import { expect } from "vitest"

import { resolveRuntimeConfig, RuntimeConfigError, type Environment } from "./env.ts"

function requiredEnvironment(): Environment {
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

it.effect("normalizes runtime values and applies defaults once for every domain", () =>
  Effect.gen(function* () {
    const configuration = yield* resolveRuntimeConfig(requiredEnvironment())

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
    })
    expect(configuration.email2FA).toBeNull()
    expect(configuration.schedule).toMatchObject({
      mode: "once",
      timezone: "America/Santiago",
      noOverlap: false,
    })
    expect(configuration.schedule.cron).toBeDefined()
    // Redacted intentionally exposes a safe placeholder through String().
    // oxlint-disable-next-line typescript/no-base-to-string
    expect(String(configuration.actual.password)).toBe("<redacted>")
    expect(Redacted.value(configuration.actual.password)).toBe("actual password")
    // oxlint-disable-next-line typescript/no-base-to-string
    expect(String(configuration.fintual.password)).toBe("<redacted>")
    expect(Redacted.value(configuration.fintual.password)).toBe("fintual password")
  }),
)

it.effect("selects scheduled mode and decodes the schedule policy", () =>
  Effect.gen(function* () {
    const configuration = yield* resolveRuntimeConfig({
      ...requiredEnvironment(),
      RUN_MODE: "schedule",
      SYNC_CRON: "0 0 6 * * 1",
      SYNC_TIMEZONE: "UTC",
      SYNC_NO_OVERLAP: "true",
    })

    expect(configuration.schedule).toMatchObject({
      mode: "schedule",
      timezone: "UTC",
      noOverlap: true,
    })
    expect(configuration.schedule.cron).toBeDefined()
  }),
)

it.effect("rejects an invalid cron expression with a typed configuration error", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        SYNC_CRON: "not a cron",
      }),
    )

    expect(result._tag).toBe("Failure")
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RuntimeConfigError)
      expect(result.failure.message).toContain("cron expression")
    }
  }),
)

it.effect("rejects an invalid schedule timezone with a typed configuration error", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        SYNC_TIMEZONE: "Not/AZone",
      }),
    )

    expect(result._tag).toBe("Failure")
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RuntimeConfigError)
      expect(result.failure.message).toContain("time zone")
    }
  }),
)

it.effect("rejects an unknown run mode", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        RUN_MODE: "forever",
      }),
    )

    expect(result._tag).toBe("Failure")
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RuntimeConfigError)
      expect(result.failure.message).toContain("RUN_MODE")
    }
  }),
)

it.effect("uses legacy starting date and enables email 2FA when both credentials are present", () =>
  Effect.gen(function* () {
    const configuration = yield* resolveRuntimeConfig({
      ...requiredEnvironment(),
      STARTING_DATE: "2025-01-02",
      ACTUAL_PAYEE: "Investments",
      GMAIL_USER_EMAIL: "mailbox@example.com",
      GMAIL_APP_PASSWORD: "app password",
      GMAIL_IMAP_HOST: "mail.example.com",
      GMAIL_IMAP_PORT: "1993",
      GMAIL_IMAP_DEBUG: "TRUE",
      FINTUAL_2FA_SENDER: "security@example.com",
    })

    expect(configuration.actual.startingDate).toBe("2025-01-02")
    expect(configuration.actual.payee).toBe("Investments")
    expect(configuration.email2FA).not.toBeNull()
    if (configuration.email2FA) {
      expect(configuration.email2FA).toMatchObject({
        userEmail: "mailbox@example.com",
        host: "mail.example.com",
        port: 1993,
        debug: true,
        sender: "security@example.com",
      })
      // oxlint-disable-next-line typescript/no-base-to-string
      expect(String(configuration.email2FA.appPassword)).toBe("<redacted>")
      expect(Redacted.value(configuration.email2FA.appPassword)).toBe("app password")
    }
  }),
)

it.effect("preserves quoted-empty values instead of falling back to defaults", () =>
  Effect.gen(function* () {
    const configuration = yield* resolveRuntimeConfig({
      ...requiredEnvironment(),
      ACTUAL_PAYEE: "''",
      STARTING_DATE: "''",
    })

    expect(configuration.actual.payee).toBe("")
    expect(configuration.actual.startingDate).toBe("")
  }),
)

it.effect("reports all missing required runtime values", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(resolveRuntimeConfig({}))

    expect(result._tag).toBe("Failure")
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RuntimeConfigError)
      expect(result.failure.cause).toBeDefined()
      expect(result.failure.message).toContain("ACTUAL_SERVER_URL")
    }
  }),
)

it.effect("treats unquoted empty required values as missing", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        ACTUAL_SERVER_URL: "",
      }),
    )

    expect(result._tag).toBe("Failure")
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("ACTUAL_SERVER_URL")
    }
  }),
)

it.effect("uses defaults when optional non-Gmail values are unquoted empty strings", () =>
  Effect.gen(function* () {
    const configuration = yield* resolveRuntimeConfig({
      ...requiredEnvironment(),
      ACTUAL_PAYEE: "",
      GMAIL_USER_EMAIL: "mailbox@example.com",
      GMAIL_APP_PASSWORD: "app password",
      GMAIL_IMAP_PORT: "",
    })

    expect(configuration.actual.payee).toBe("Fintual")
    expect(configuration.email2FA?.port).toBe(993)
  }),
)

it.effect("rejects partially configured email 2FA credentials", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        GMAIL_USER_EMAIL: "mailbox@example.com",
      }),
    )

    expect(result._tag).toBe("Failure")
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RuntimeConfigError)
      expect(result.failure.message).toBe("Missing environment variables: GMAIL_APP_PASSWORD")
    }
  }),
)

it.effect("rejects a Gmail app password without its user email", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        GMAIL_APP_PASSWORD: "app password",
      }),
    )

    expect(result._tag).toBe("Failure")
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RuntimeConfigError)
      expect(result.failure.message).toBe("Missing environment variables: GMAIL_USER_EMAIL")
    }
  }),
)

it.effect("preserves explicitly supplied empty Gmail credentials as present values", () =>
  Effect.gen(function* () {
    const configuration = yield* resolveRuntimeConfig({
      ...requiredEnvironment(),
      GMAIL_USER_EMAIL: "",
      GMAIL_APP_PASSWORD: "",
    })

    expect(configuration.email2FA).not.toBeNull()
    if (configuration.email2FA) {
      expect(configuration.email2FA.userEmail).toBe("")
      expect(Redacted.value(configuration.email2FA.appPassword)).toBe("")
    }
  }),
)

it.effect("rejects an invalid email 2FA port", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      resolveRuntimeConfig({
        ...requiredEnvironment(),
        GMAIL_USER_EMAIL: "mailbox@example.com",
        GMAIL_APP_PASSWORD: "app password",
        GMAIL_IMAP_PORT: "not-a-port",
      }),
    )

    expect(result._tag).toBe("Failure")
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("GMAIL_IMAP_PORT")
    }
  }),
)

it.effect("ignores email 2FA settings when automatic retrieval is disabled", () =>
  Effect.gen(function* () {
    const configuration = yield* resolveRuntimeConfig({
      ...requiredEnvironment(),
      GMAIL_IMAP_PORT: "not-a-port",
    })

    expect(configuration.email2FA).toBeNull()
  }),
)
