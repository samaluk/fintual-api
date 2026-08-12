import { it as effectIt } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"

import type { RuntimeConfig } from "./env.ts"
import { email2FASecret, fintualSecret, runtimeConfig, secret } from "./log-test-fixtures.ts"
import { RedactionPolicy } from "./log.ts"

describe("RedactionPolicy", () => {
  it("redacts every sensitive configured value from the start, including Redacted passwords", () => {
    const policy = RedactionPolicy.fromConfig(runtimeConfig)

    expect(policy.redact(`actual ${secret} fintual ${fintualSecret} gmail ${email2FASecret}`)).toBe(
      "actual [redacted] fintual [redacted] gmail [redacted]",
    )
  })

  it("redacts configured identifiers and email addresses", () => {
    const policy = RedactionPolicy.fromConfig(runtimeConfig)

    expect(
      policy.redact(
        "sync sync-1 account fintual-account goal goal-42 mail user@example.com 2fa 2fa@example.com other@example.com",
      ),
    ).toBe(
      "sync [redacted] account [redacted] goal [redacted] mail [redacted] 2fa [redacted] [redacted email]",
    )
  })

  it("keeps redaction state isolated between policies", () => {
    const configured = RedactionPolicy.fromConfig(runtimeConfig)
    const empty = RedactionPolicy.empty

    expect(configured.redact(secret)).toBe("[redacted]")
    expect(empty.redact(secret)).toBe(secret)
  })

  it("captures the sensitive snapshot once when the policy is built", () => {
    const config: RuntimeConfig = {
      actual: {
        serverUrl: "http://localhost:5006",
        password: Redacted.make(secret),
        syncId: "sync-before-build",
        fintualAccount: "fintual-account",
        startingDate: "2024-03-01",
        payee: "Fintual",
      },
      fintual: {
        email: "user@example.com",
        password: Redacted.make("fintual-pass"),
        goalId: "goal-42",
        email2FA: null,
      },
      schedule: {
        mode: "once",
        cron: "0 0 22 * * 1-5",
        timezone: "America/Santiago",
        noOverlap: false,
      },
    }
    const policy = RedactionPolicy.fromConfig(config)

    config.actual.syncId = "sync-added-after-build"

    expect(policy.redact("sync-before-build sync-added-after-build")).toBe(
      "[redacted] sync-added-after-build",
    )
  })

  effectIt.effect("provides an immutable policy layer from the validated runtime config", () =>
    Effect.gen(function* () {
      const policy = yield* RedactionPolicy

      expect(policy.redact(`secret ${secret} and goal-42`)).toBe("secret [redacted] and [redacted]")
    }).pipe(Effect.provide(RedactionPolicy.layer(runtimeConfig))),
  )
})
