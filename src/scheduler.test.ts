import { it } from "@effect/vitest"
import {
  Array as EffectArray,
  Cause,
  Cron,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Formatter,
  Logger,
  Ref,
  Result,
} from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"

import { LoginFailed } from "./fintual/fintual-error.ts"
import { runScheduler, type SchedulerOptions } from "./scheduler.ts"

function schedulerOptions(overrides: Partial<SchedulerOptions> = {}): SchedulerOptions {
  return {
    cron: Result.getOrThrow(Cron.parse("* * * * *", "UTC")),
    timezone: "UTC",
    noOverlap: false,
    ...overrides,
  }
}

function cron(expression: string, timezone: string): Cron.Cron {
  return Result.getOrThrow(Cron.parse(expression, timezone))
}

interface CapturedLog {
  readonly level: string
  readonly message: string
}

function capturingLogger(lines: Array<CapturedLog>): Logger.Logger<unknown, void> {
  return Logger.make(({ logLevel, message }) => {
    const parts = EffectArray.ensure(message).map((part) =>
      typeof part === "string" ? part : Formatter.format(part),
    )
    lines.push({ level: logLevel, message: parts.join(" ") })
  })
}

describe("runScheduler", () => {
  it.effect("runs the job at each cron occurrence, not at startup", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const job = Ref.update(attempts, (n) => n + 1)
      const fiber = yield* Effect.forkChild(
        runScheduler(job, schedulerOptions({ timezone: "America/Santiago" })),
      )

      expect(yield* Ref.get(attempts)).toBe(0)

      yield* TestClock.adjust("1 minute")
      expect(yield* Ref.get(attempts)).toBe(1)

      yield* TestClock.adjust("1 minute")
      expect(yield* Ref.get(attempts)).toBe(2)

      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("fires according to the configured timezone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-02-03T12:00:00Z"))

      const utcAttempts = yield* Ref.make(0)
      const kolkataAttempts = yield* Ref.make(0)
      const utcJob = Ref.update(utcAttempts, (n) => n + 1)
      const kolkataJob = Ref.update(kolkataAttempts, (n) => n + 1)
      const utcFiber = yield* Effect.forkChild(
        runScheduler(utcJob, { ...schedulerOptions(), cron: cron("30 * * * *", "UTC") }),
      )
      const kolkataFiber = yield* Effect.forkChild(
        runScheduler(kolkataJob, {
          ...schedulerOptions(),
          cron: cron("30 * * * *", "Asia/Kolkata"),
          timezone: "Asia/Kolkata",
        }),
      )

      yield* TestClock.adjust("30 minutes")

      expect(yield* Ref.get(utcAttempts)).toBe(1)
      expect(yield* Ref.get(kolkataAttempts)).toBe(0)

      yield* TestClock.adjust("30 minutes")

      expect(yield* Ref.get(utcAttempts)).toBe(1)
      expect(yield* Ref.get(kolkataAttempts)).toBe(1)

      yield* Fiber.interrupt(utcFiber)
      yield* Fiber.interrupt(kolkataFiber)
    }),
  )

  it.effect("logs a failed tick and continues to the next occurrence", () =>
    Effect.gen(function* () {
      const lines: Array<CapturedLog> = []
      const attempts = yield* Ref.make(0)
      const job = Effect.gen(function* () {
        const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
        if (attempt === 1) return yield* new LoginFailed({ status: 500 })
      })
      const fiber = yield* Effect.forkChild(
        runScheduler(job, schedulerOptions()).pipe(
          Effect.provide(Logger.layer([capturingLogger(lines)])),
        ),
      )

      yield* TestClock.adjust("1 minute")
      expect(yield* Ref.get(attempts)).toBe(1)

      yield* TestClock.adjust("1 minute")
      expect(yield* Ref.get(attempts)).toBe(2)
      expect(lines.map((line) => line.level)).toContain("Error")

      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("stops cleanly when interrupted", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const job = Ref.update(attempts, (n) => n + 1)
      const fiber = yield* Effect.forkChild(runScheduler(job, schedulerOptions()))

      yield* TestClock.adjust("1 minute")
      expect(yield* Ref.get(attempts)).toBe(1)

      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )

  it.effect("prevents a concurrent run when no-overlap is enabled", () =>
    Effect.gen(function* () {
      const lines: Array<CapturedLog> = []
      const attempts = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const job = Effect.gen(function* () {
        yield* Ref.update(attempts, (n) => n + 1)
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        yield* Deferred.succeed(done, undefined)
      })
      const fiber = yield* Effect.forkChild(
        runScheduler(job, schedulerOptions({ noOverlap: true })).pipe(
          Effect.provide(Logger.layer([capturingLogger(lines)])),
        ),
      )

      yield* TestClock.adjust("1 minute")
      yield* Deferred.await(started)
      expect(yield* Ref.get(attempts)).toBe(1)

      yield* TestClock.adjust("1 minute")
      expect(yield* Ref.get(attempts)).toBe(1)
      expect(lines.map((line) => line.level)).toContain("Warn")

      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(done)

      yield* TestClock.adjust("1 minute")
      expect(yield* Ref.get(attempts)).toBe(2)

      yield* Fiber.interrupt(fiber)
    }),
  )
})
