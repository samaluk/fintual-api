import { it } from "@effect/vitest"
import { Cron, Effect, Layer, Option, Redacted, Result } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "vitest"

import { ActualSynchronization } from "./actual.ts"
import { ActualClientFactory, type ActualClient } from "./actual/actual-client.ts"
import {
  ActualConfigService,
  Email2FAConfigService,
  FintualConfigService,
  ScheduleConfigService,
} from "./env.ts"
import { LoginFailed } from "./fintual/fintual-error.ts"
import { FintualPerformance } from "./fintual/performance.ts"
import { Job } from "./job.ts"
import type { PerformanceSnapshot } from "./performance-snapshot.ts"

const SNAPSHOT: PerformanceSnapshot = {
  balance: [{ date: 1, value: 100, difference: 5, real_difference: 5 }],
  deposits: [{ date: 1, value: 95, difference: 5 }],
}

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

function configLayer() {
  return Layer.mergeAll(
    Layer.succeed(ActualConfigService, CONFIG.actual),
    Layer.succeed(FintualConfigService, CONFIG.fintual),
    Layer.succeed(Email2FAConfigService, Option.none()),
    Layer.succeed(ScheduleConfigService, {
      mode: "once" as const,
      cron: Result.getOrThrow(Cron.parse("* * * * *", "UTC")),
      timezone: "UTC",
      noOverlap: false,
    }),
  )
}

it.effect("downloads before synchronizing and exposes the original domain failures", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const jobLayer = Job.layer.pipe(
      Layer.provide(
        Layer.succeed(FintualPerformance, {
          fetchPerformanceSnapshot: Effect.sync(() => {
            calls.push("fintual")
            return SNAPSHOT
          }),
        }),
      ),
      Layer.provide(
        Layer.succeed(ActualSynchronization, {
          synchronize: (snapshot) =>
            Effect.sync(() => {
              calls.push(`actual:${snapshot.balance.length}`)
            }),
        }),
      ),
    )

    const job = yield* Effect.service(Job).pipe(Effect.provide(jobLayer))
    yield* job.synchronize()

    expect(calls).toEqual(["fintual", "actual:1"])
  }),
)

it.effect("preserves a Fintual failure and does not start Actual", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const jobLayer = Job.layer.pipe(
      Layer.provide(
        Layer.succeed(FintualPerformance, {
          fetchPerformanceSnapshot: Effect.fail(new LoginFailed({ status: 401 })),
        }),
      ),
      Layer.provide(
        Layer.succeed(ActualSynchronization, {
          synchronize: () => Effect.sync(() => calls.push("actual")),
        }),
      ),
    )

    const job = yield* Effect.service(Job).pipe(Effect.provide(jobLayer))
    const error = yield* Effect.flip(job.synchronize())

    expect(error).toBeInstanceOf(LoginFailed)
    expect(calls).toEqual([])
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
      response("", 200),
    ])
    const actualClient: ActualClient = {
      reconcile: (snapshot, options) =>
        Effect.sync(() => {
          calls.push(`reconcile:${snapshot.balance.length}:${options.accountId}`)
          return { created: 1, updated: 0, deletedDuplicates: 0 }
        }),
      shutdown: Effect.void,
    }
    const fintualLayer = FintualPerformance.layer
    const actualLayer = ActualSynchronization.layer.pipe(
      Layer.provide(
        Layer.succeed(ActualClientFactory, {
          acquire: () => Effect.succeed(actualClient),
        }),
      ),
    )
    const appLayer = Job.layer.pipe(Layer.provide(fintualLayer), Layer.provide(actualLayer))

    const rootLayer = appLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(configLayer(), Layer.succeed(FetchHttpClient.Fetch, script.fetch)),
      ),
    )
    const job = yield* Effect.service(Job).pipe(Effect.provide(rootLayer))
    yield* job.synchronize()

    expect(calls).toEqual(["reconcile:1:account-id"])
    expect(script.requests).toHaveLength(5)
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
