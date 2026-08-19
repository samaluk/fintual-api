import { it as effectIt } from "@effect/vitest"
import { Cause, Console, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { getErrorMessage, RedactingLogger, reportUnhandledFailure } from "./logging.ts"

const secret = "hunter2-super-secret"
const fintualSecret = "fintual-pass"
const email2FASecret = "app-password"
const sampleSecrets = [
  "http://localhost:5006",
  secret,
  "sync-1",
  "fintual-account",
  "user@example.com",
  fintualSecret,
  "goal-42",
  "2fa@example.com",
  email2FASecret,
]

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

describe("RedactingLogger", () => {
  effectIt.effect("renders timestamped, level-prefixed lines with sensitive values redacted", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const program = Effect.gen(function* () {
        yield* Effect.logInfo(`Connecting with password ${secret}`)
        yield* Effect.logError(Cause.fail(new Error(`auth failed with ${secret}`)))
      })

      yield* program.pipe(
        Effect.provide(RedactingLogger.layer(sampleSecrets)),
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
      const lines: Array<string> = []
      const program = Effect.logInfo("creating goal").pipe(
        Effect.annotateLogs({ goalId: "goal-42" }),
      )

      yield* program.pipe(
        Effect.provide(RedactingLogger.layer(sampleSecrets)),
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
      const lines: Array<string> = []
      const program = Effect.logInfo("password is", secret, "on", "goal-42")

      yield* program.pipe(
        Effect.provide(RedactingLogger.layer(sampleSecrets)),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: password is \[redacted\] on \[redacted\]$/,
      )
    }),
  )

  effectIt.effect("redacts configured identifiers and arbitrary email addresses", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const program = Effect.logInfo(
        "sync sync-1 account fintual-account goal goal-42 mail user@example.com 2fa 2fa@example.com other@example.com",
      )

      yield* program.pipe(
        Effect.provide(RedactingLogger.layer(sampleSecrets)),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: sync \[redacted\] account \[redacted\] goal \[redacted\] mail \[redacted\] 2fa \[redacted\] \[redacted email\]$/,
      )
    }),
  )

  effectIt.effect("keeps redaction state isolated between logger layers", () =>
    Effect.gen(function* () {
      const configuredLines: Array<string> = []
      const emptyLines: Array<string> = []

      yield* Effect.logInfo(secret).pipe(
        Effect.provide(RedactingLogger.layer(sampleSecrets)),
        Effect.provideService(Console.Console, captureConsole(configuredLines)),
      )
      yield* Effect.logInfo(secret).pipe(
        Effect.provide(RedactingLogger.empty),
        Effect.provideService(Console.Console, captureConsole(emptyLines)),
      )

      expect(configuredLines[0]).toContain("[redacted]")
      expect(configuredLines[0]).not.toContain(secret)
      expect(emptyLines[0]).toContain(secret)
    }),
  )

  effectIt.effect("captures the sensitive snapshot once when the layer is built", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const mutableSecrets = ["sync-before-build"]
      const layer = RedactingLogger.layer(mutableSecrets)

      mutableSecrets.push("sync-added-after-build")

      yield* Effect.logInfo("sync-before-build sync-added-after-build").pipe(
        Effect.provide(layer),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines[0]).toContain("[redacted] sync-added-after-build")
    }),
  )
})

describe("reportUnhandledFailure", () => {
  effectIt.effect("logs defects from a cause, not just typed failures", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const program = Effect.die(new Error(`config exploded with ${secret}`)).pipe(
        Effect.tapCause(reportUnhandledFailure),
        Effect.ignoreCause,
      )

      yield* program.pipe(
        Effect.provide(RedactingLogger.layer(sampleSecrets)),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ERROR: Error: config exploded with \[redacted\]/,
      )
      expect(lines[0]).not.toContain(secret)
    }),
  )

  effectIt.effect("reports non-interrupt failures through the redacting logger", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const program = Effect.fail(
        new UnexpectedFailure({ cause: new Error(`unexpected ${secret}`) }),
      ).pipe(Effect.tapCause(reportUnhandledFailure), Effect.ignoreCause)

      yield* program.pipe(
        Effect.provide(RedactingLogger.layer(sampleSecrets)),
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
      const lines: Array<string> = []
      const program = Effect.interrupt.pipe(
        Effect.tapCause(reportUnhandledFailure),
        Effect.ignoreCause,
      )

      yield* program.pipe(
        Effect.provide(RedactingLogger.layer(sampleSecrets)),
        Effect.provideService(Console.Console, captureConsole(lines)),
      )

      expect(lines).toHaveLength(0)
    }),
  )
})

describe("getErrorMessage", () => {
  it("formats Error instances", () => {
    expect(getErrorMessage(new Error("something broke"))).toBe("something broke")
  })

  it("formats structured error objects with type, reason, and message", () => {
    expect(
      getErrorMessage({
        type: "NetworkError",
        reason: "timeout",
        message: "failed after 30s",
      }),
    ).toBe("NetworkError: timeout: failed after 30s")
  })

  it("formats arbitrary non-empty string errors", () => {
    expect(getErrorMessage("plain error string")).toBe("plain error string")
  })

  it("falls back to Unknown error for undefined/null/empty values", () => {
    expect(getErrorMessage(null)).toBe("Unknown error")
    expect(getErrorMessage(undefined)).toBe("Unknown error")
    expect(getErrorMessage("   ")).toBe("Unknown error")
  })
})
