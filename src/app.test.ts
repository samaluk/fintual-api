import { it } from "@effect/vitest"
import { Cron, Effect, Fiber, Layer, Option, Redacted, Ref, Result } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "vitest"

import { ActualSynchronization } from "./actual.ts"
import { ActualClientFactory, type ActualClient } from "./actual/actual-client.ts"
import { ActualFileSystem } from "./actual/actual-file-system.ts"
import { ActualHealthCheck } from "./actual/actual-health-check.ts"
import { ActualRetryPolicy } from "./actual/retry-policy.ts"
import { runApplication } from "./app.ts"
import {
  ActualConfigService,
  Email2FAConfigService,
  FintualConfigService,
  ScheduleConfigService,
} from "./env.ts"
import { FintualPerformance } from "./fintual/performance.ts"
import { Job } from "./job.ts"

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

it.effect("runs the assembled Fintual-to-Actual workflow once", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const script = createFetchScript([
      response("", 200, "session=sign-in"),
      response("{}"),
      goalPerformanceResponse("2026-01-01", { costBasis: 80, valuation: 100 }),
      goalPerformanceResponse("2026-07-01", { costBasis: 90, valuation: 115 }),
    ])
    const actualClient: ActualClient = {
      downloadBudget: () => Effect.void,
      getTransactions: () => Effect.succeed([]),
      getPayees: Effect.succeed([{ id: "payee-id", name: "Fintual" }]),
      createTransaction: (_accountId, transaction) =>
        Effect.sync(() => calls.push(`create:${transaction.date}`)),
      updateTransaction: () => Effect.void,
      deleteTransaction: () => Effect.void,
      sync: Effect.void,
      shutdown: Effect.void,
    }
    const fintualLayer = FintualPerformance.layer
    const actualLayer = ActualSynchronization.layer.pipe(
      Layer.provide(
        Layer.succeed(ActualClientFactory, {
          acquire: () => Effect.succeed(actualClient),
        }),
      ),
      Layer.provide(
        Layer.succeed(ActualFileSystem, { reset: Effect.sync(() => calls.push("reset")) }),
      ),
      Layer.provide(
        Layer.succeed(ActualHealthCheck, { check: Effect.sync(() => calls.push("health")) }),
      ),
      Layer.provide(ActualRetryPolicy.live),
    )
    const appLayer = Job.layer.pipe(Layer.provide(fintualLayer), Layer.provide(actualLayer))

    const rootLayer = appLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(configLayer("once"), Layer.succeed(FetchHttpClient.Fetch, script.fetch)),
      ),
    )
    const job = yield* Effect.service(Job).pipe(Effect.provide(rootLayer))
    yield* job.synchronize()

    expect(calls).toEqual(["reset", "health", "create:2026-07-01"])
    expect(script.requests).toHaveLength(4)
  }),
)

interface FetchScript {
  readonly fetch: typeof globalThis.fetch
  readonly requests: Array<{ readonly url: string }>
}

function createFetchScript(responses: Array<Response>): FetchScript {
  const requests: Array<{ readonly url: string }> = []
  const fetch: typeof globalThis.fetch = async (input) => {
    requests.push({ url: input instanceof Request ? input.url : String(input) })
    const responseValue = responses.shift()
    if (!responseValue) {
      throw new Error("Unexpected Fintual request")
    }
    return responseValue
  }
  return { fetch, requests }
}

function response(body: string, status = 200, setCookie?: string): Response {
  return new Response(body, {
    status,
    headers: setCookie ? { "Set-Cookie": setCookie } : undefined,
  })
}

function goalPerformanceResponse(
  date: string,
  amounts: { readonly costBasis: number; readonly valuation: number },
): Response {
  return response(
    JSON.stringify({
      data: {
        balanceGraphDataPoints: [
          {
            date,
            unrealizedCostBasisAmount: amounts.costBasis,
            unrealizedGainOrLossAmount: 10,
            realizedCostBasisAmount: 90,
            realizedGainOrLossAmount: 5,
            sharesCostBasisAmount: 95,
            sharesValuationAmount: amounts.valuation,
            pendingFulfillmentReinvestmentDepositsCostBasisAmount: 0,
            pendingFulfillmentReinvestmentDepositsAmount: 0,
            withdrawnAmount: 0,
          },
        ],
      },
    }),
  )
}
