import { it } from "@effect/vitest"
import { Cron, Effect, Fiber, Layer, Option, Redacted, Ref, Result } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import {
  ActualConfigService,
  Email2FAConfigService,
  FintualConfigService,
  ScheduleConfigService,
} from "./env.ts"
import { Job } from "./job.ts"
import { runApplication } from "./main.ts"

const CONFIG = {
  actual: {
    serverUrl: "https://actual.example.test",
    password: Redacted.make("actual-password"),
    syncId: "sync-id",
    fintualAccount: "account-id",
    startingDate: "2024-01-01",
    payee: "Fintual",
  },
  fintual: {
    email: "investor@example.com",
    password: Redacted.make("fintual-password"),
    goalId: "goal-id",
  },
}

function schedule(mode: "once" | "schedule") {
  return {
    mode,
    cron: Result.getOrThrow(Cron.parse("* * * * *", "UTC")),
    timezone: "UTC",
    noOverlap: false,
  } as const
}

function configLayer(mode: "once" | "schedule") {
  return Layer.mergeAll(
    Layer.succeed(ActualConfigService, CONFIG.actual),
    Layer.succeed(FintualConfigService, CONFIG.fintual),
    Layer.succeed(Email2FAConfigService, Option.none()),
    Layer.succeed(ScheduleConfigService, schedule(mode)),
  )
}

it.effect("runs exactly one Job synchronization in once mode", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const jobLayer = Layer.succeed(Job, {
      synchronize: () => Ref.update(attempts, (count) => count + 1),
    })

    yield* runApplication().pipe(Effect.provide(Layer.merge(jobLayer, configLayer("once"))))

    expect(yield* Ref.get(attempts)).toBe(1)
  }),
)

it.effect("passes the Job effect to the scheduler in schedule mode", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const jobLayer = Layer.succeed(Job, {
      synchronize: () => Ref.update(attempts, (count) => count + 1),
    })

    const fiber = yield* Effect.forkChild(
      runApplication().pipe(Effect.provide(Layer.merge(jobLayer, configLayer("schedule")))),
    )
    yield* TestClock.adjust("1 minute")

    expect(yield* Ref.get(attempts)).toBe(1)
    yield* Fiber.interrupt(fiber)
  }),
)
