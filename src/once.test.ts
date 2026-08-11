import { it as effectIt } from "@effect/vitest"
import { Cause, Console, Effect, Logger, Redacted, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { RuntimeConfig } from "./env.ts"
import {
  configureSensitiveValues,
  getErrorMessage,
  redactSensitiveText,
  revealSecret,
} from "./log.ts"
import { redactingLogger, reportUnhandledFailure } from "./once.ts"

const secret = "hunter2-super-secret"

const runtimeConfig: RuntimeConfig = {
  actual: {
    serverUrl: "http://localhost:5006",
    password: Redacted.make(secret),
    syncId: "sync-1",
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
}

class UnexpectedFailure extends Schema.TaggedError<UnexpectedFailure>()("UnexpectedFailure", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return getErrorMessage(this.cause)
  }

  override get name(): string {
    // Keep Cause.pretty's prefix as `Error:` so the render assertion stays faithful.
    return "Error"
  }
}

function configureLoggingSecrets(): void {
  configureSensitiveValues(runtimeConfig)
  revealSecret(runtimeConfig.actual.password)
}

function captureConsole(lines: Array<string>): Console.Console {
  return {
    assert: () => {},
    clear: () => {},
    count: () => {},
    countReset: () => {},
    debug: (line: string) => lines.push(line),
    dir: () => {},
    dirxml: () => {},
    error: (line: string) => lines.push(line),
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    info: (line: string) => lines.push(line),
    log: (line: string) => lines.push(line),
    table: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    trace: () => {},
    warn: (line: string) => lines.push(line),
  }
}

it("registers redacted credentials when an adapter reveals them", () => {
  configureSensitiveValues(runtimeConfig)
  expect(redactSensitiveText(secret)).toBe(secret)

  revealSecret(runtimeConfig.actual.password)

  expect(redactSensitiveText(secret)).toBe("[redacted]")
})

describe("redactingLogger", () => {
  effectIt.effect("renders timestamped, level-prefixed lines with sensitive values redacted", () =>
    Effect.gen(function* () {
      configureLoggingSecrets()
      const lines: Array<string> = []
      const program = Effect.gen(function* () {
        yield* Effect.logInfo(`Connecting with password ${secret}`)
        yield* Effect.logError(Cause.fail(new Error(`auth failed with ${secret}`)))
      })

      yield* program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: Connecting with password \[redacted\]$/,
      )
      expect(lines[1]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ERROR: Error: auth failed with \[redacted\]/,
      )
      expect(lines[1]).not.toContain(secret)
    }),
  )

  effectIt.effect("redacts annotation values", () =>
    Effect.gen(function* () {
      configureLoggingSecrets()
      const lines: Array<string> = []
      const program = Effect.gen(function* () {
        yield* Effect.logInfo("creating goal").pipe(Effect.annotateLogs({ goalId: "goal-42" }))
      })

      yield* program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: creating goal goalId: \[redacted\]$/,
      )
    }),
  )

  effectIt.effect("redacts secrets split across message parts", () =>
    Effect.gen(function* () {
      configureLoggingSecrets()
      const lines: Array<string> = []
      const program = Effect.gen(function* () {
        yield* Effect.logInfo("password is", secret, "on", "goal-42")
      })

      yield* program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: password is \[redacted\] on \[redacted\]$/,
      )
    }),
  )
})

describe("reportUnhandledFailure", () => {
  effectIt.effect("reports non-interrupt failures through the redacting logger", () =>
    Effect.gen(function* () {
      configureLoggingSecrets()
      const lines: Array<string> = []
      const program = Effect.fail(
        new UnexpectedFailure({ cause: new Error(`unexpected ${secret}`) }),
      ).pipe(
        Effect.tapCause(reportUnhandledFailure),
        Effect.catchCause(() => Effect.void),
      )

      yield* program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ERROR: Error: unexpected \[redacted\]/,
      )
      expect(lines[0]).not.toContain(secret)
    }),
  )

  effectIt.effect("stays silent for interrupt-only causes", () =>
    Effect.gen(function* () {
      configureLoggingSecrets()
      const lines: Array<string> = []
      const program = Effect.interrupt.pipe(
        Effect.tapCause(reportUnhandledFailure),
        Effect.catchCause(() => Effect.void),
      )

      yield* program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines).toHaveLength(0)
    }),
  )
})
