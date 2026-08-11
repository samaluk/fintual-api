import { Cause, Console, Effect, Logger } from "effect"
import { describe, expect, it } from "vitest"
import type { RuntimeConfig } from "./env.ts"
import { configureSensitiveValues } from "./log.ts"
import { redactingLogger, reportUnhandledFailure } from "./once.ts"

const secret = "hunter2-super-secret"

const runtimeConfig: RuntimeConfig = {
  actual: {
    serverUrl: "http://localhost:5006",
    password: secret,
    syncId: "sync-1",
    fintualAccount: "fintual-account",
    startingDate: "2024-03-01",
    payee: "Fintual",
  },
  fintual: {
    email: "user@example.com",
    password: "fintual-pass",
    goalId: "goal-42",
    email2FA: null,
  },
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

describe("redactingLogger", () => {
  it("renders timestamped, level-prefixed lines with sensitive values redacted", async () => {
    configureSensitiveValues(runtimeConfig)
    const lines: Array<string> = []
    const program = Effect.gen(function* () {
      yield* Effect.logInfo(`Connecting with password ${secret}`)
      yield* Effect.logError(Cause.fail(new Error(`auth failed with ${secret}`)))
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      ),
    )

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: Connecting with password \[redacted\]$/,
    )
    expect(lines[1]).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ERROR: Error: auth failed with \[redacted\]/,
    )
    expect(lines[1]).not.toContain(secret)
  })

  it("redacts annotation values", async () => {
    configureSensitiveValues(runtimeConfig)
    const lines: Array<string> = []
    const program = Effect.gen(function* () {
      yield* Effect.logInfo("creating goal").pipe(Effect.annotateLogs({ goalId: "goal-42" }))
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      ),
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: creating goal goalId: \[redacted\]$/,
    )
  })

  it("redacts secrets split across message parts", async () => {
    configureSensitiveValues(runtimeConfig)
    const lines: Array<string> = []
    const program = Effect.gen(function* () {
      yield* Effect.logInfo("password is", secret, "on", "goal-42")
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      ),
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: password is \[redacted\] on \[redacted\]$/,
    )
  })
})

describe("reportUnhandledFailure", () => {
  it("reports non-interrupt failures through the redacting logger", async () => {
    configureSensitiveValues(runtimeConfig)
    const lines: Array<string> = []
    const program = Effect.fail(new Error(`unexpected ${secret}`)).pipe(
      Effect.tapCause(reportUnhandledFailure),
      Effect.catchCause(() => Effect.void),
    )

    await Effect.runPromise(
      program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      ),
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ERROR: Error: unexpected \[redacted\]/)
    expect(lines[0]).not.toContain(secret)
  })

  it("stays silent for interrupt-only causes", async () => {
    configureSensitiveValues(runtimeConfig)
    const lines: Array<string> = []
    const program = Effect.interrupt.pipe(
      Effect.tapCause(reportUnhandledFailure),
      Effect.catchCause(() => Effect.void),
    )

    await Effect.runPromise(
      program.pipe(
        Effect.provide(Logger.layer([redactingLogger])),
        Effect.provideService(Console.Console, captureConsole(lines)),
      ),
    )

    expect(lines).toHaveLength(0)
  })
})
