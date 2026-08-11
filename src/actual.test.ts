import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, Redacted, Result, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, expect, vi } from "vitest"

const actualApiMock = vi.hoisted(() => ({
  init: vi.fn(),
  downloadBudget: vi.fn(),
  getTransactions: vi.fn(),
  getPayees: vi.fn(),
  addTransactions: vi.fn(),
  updateTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
  sync: vi.fn(),
  shutdown: vi.fn(),
}))

vi.mock("@actual-app/api", () => actualApiMock)
import { ActualConfigService, ActualSynchronization } from "./actual.ts"
import {
  ActualBudgetDownloadFailure,
  ActualInitializationFailure,
  ActualTransactionCreationFailure,
} from "./actual/actual-error.ts"
import { ActualClientFactory, type ActualClient } from "./actual/actual-client.ts"
import { ActualFileSystem } from "./actual/actual-file-system.ts"
import { ActualHealthCheck } from "./actual/actual-health-check.ts"
import { ActualRetryPolicy } from "./actual/retry-policy.ts"
import type { ActualError } from "./actual/actual-error.ts"
import type { ActualConfig } from "./env.ts"
import type { PerformanceSnapshot } from "./performance-snapshot.ts"

afterEach(() => {
  vi.resetAllMocks()
})

const CONFIG: ActualConfig = {
  serverUrl: "https://actual.example.test/",
  password: Redacted.make("secret"),
  syncId: "sync-id",
  fintualAccount: "account-id",
  startingDate: "2026-01-01",
  payee: "Fintual",
}

const SNAPSHOT: PerformanceSnapshot = {
  balance: [
    {
      date: Date.parse("2026-01-05T00:00:00Z"),
      value: 1_100,
      difference: 50,
      real_difference: 12.49,
    },
  ],
  deposits: [
    {
      date: Date.parse("2026-01-05T00:00:00Z"),
      value: 1_000,
      difference: 25,
    },
  ],
}

it.effect("synchronizes through one service and shuts down the Actual session once", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const client = scriptedClient(calls)

    yield* synchronizationProgram([client], calls)

    expect(calls).toEqual([
      "reset",
      "health",
      "download",
      "transactions",
      "payees",
      "create:2026-01-05",
      "sync",
      "shutdown",
    ])
  }),
)

it.effect("retries a failed mutation as a fresh Synchronization Attempt", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const importedTransaction = {
      id: "created-after-timeout",
      date: "2026-01-05",
      notes: "Variation",
      payee: "payee-id",
      imported_id: "fintual-variation:2026-01-05",
    }
    const secondAttemptTransactions: Array<typeof importedTransaction> = []
    const firstAttempt = scriptedClient(calls, {
      create: (_accountId, transaction) => {
        calls.push(`create:${transaction.date}`)
        secondAttemptTransactions.push(importedTransaction)
        return Effect.fail(
          new ActualTransactionCreationFailure({
            cause: { code: "network-failure" },
            retryable: true,
          }),
        )
      },
    })
    const secondAttempt = scriptedClient(calls, {
      transactions: secondAttemptTransactions,
    })

    yield* synchronizationProgram([firstAttempt, secondAttempt], calls, { retries: 1 })

    expect(calls).toEqual([
      "reset",
      "health",
      "download",
      "transactions",
      "payees",
      "create:2026-01-05",
      "shutdown",
      "reset",
      "health",
      "download",
      "transactions",
      "payees",
      "update:created-after-timeout",
      "sync",
      "shutdown",
    ])
  }),
)

it.effect("does not retry a non-retryable Actual failure", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const client: ActualClient = {
      ...scriptedClient(calls),
      downloadBudget: () =>
        Effect.gen(function* () {
          calls.push("download")
          return yield* new ActualBudgetDownloadFailure({
            cause: { code: "budget-not-found" },
            retryable: false,
          })
        }),
    }

    const error = yield* Effect.flip(synchronizationProgram([client], calls, { retries: 3 }))

    expect(error).toMatchObject({
      _tag: "ActualBudgetDownloadFailure",
      retryable: false,
    })
    expect(calls).toEqual(["reset", "health", "download", "shutdown"])
  }),
)

it.effect("the live Actual adapter preserves stable SDK network codes", () =>
  Effect.gen(function* () {
    actualApiMock.init.mockResolvedValue({})
    actualApiMock.downloadBudget.mockRejectedValue({ code: "network-failure" })

    const result = yield* Effect.result(
      Effect.gen(function* () {
        const factory = yield* ActualClientFactory
        const client = yield* factory.acquire(CONFIG)
        return yield* client.downloadBudget(CONFIG.syncId)
      }).pipe(Effect.provide(ActualClientFactory.live)),
    )

    expect(Result.isFailure(result)).toBe(true)
    expect(actualApiMock.init).toHaveBeenCalledWith(expect.objectContaining({ password: "secret" }))
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ActualBudgetDownloadFailure",
        cause: { code: "network-failure" },
        retryable: true,
      })
    }
  }),
)

it.effect("health checks normalize the server URL and classify HTTP failures", () =>
  Effect.gen(function* () {
    const urls: string[] = []
    const fetchRequest: typeof globalThis.fetch = async (input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      return new Response("", { status: 503 })
    }
    const program = Effect.gen(function* () {
      const healthCheck = yield* ActualHealthCheck
      yield* healthCheck.check("https://actual.example.test/")
    }).pipe(Effect.provide(ActualHealthCheck.layer(fetchRequest)))

    const error = yield* Effect.flip(program)

    expect(error).toMatchObject({
      _tag: "ActualHealthCheckFailure",
      status: 503,
      retryable: true,
      url: "https://actual.example.test/health",
    })
    expect(urls).toEqual(["https://actual.example.test/health"])
  }),
)

it.effect("health-check timeout is controlled by the Effect Clock", () =>
  Effect.gen(function* () {
    const fetchRequest: typeof globalThis.fetch = async () => new Promise<Response>(() => {})
    const healthCheck = Effect.gen(function* () {
      const service = yield* ActualHealthCheck
      yield* service.check("https://actual.example.test")
    }).pipe(Effect.provide(ActualHealthCheck.layer(fetchRequest)))
    const fiber = yield* Effect.forkChild(healthCheck)
    yield* TestClock.adjust(10_000)
    const result = yield* Effect.result(Fiber.join(fiber))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ActualHealthCheckFailure",
        retryable: true,
      })
    }
  }),
)

it.effect("uses the Effect Clock for the transaction end date", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const endingDates: string[] = []
    const client = scriptedClient(calls, {
      onTransactions: (_startDate, endDate) => endingDates.push(endDate),
    })

    yield* TestClock.setTime(Date.parse("2026-02-03T12:00:00Z"))
    yield* synchronizationProgram([client], calls)

    expect(endingDates).toEqual(["2026-02-03"])
  }),
)

it.effect("shuts down the scoped Actual session when the workflow is interrupted", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const client = scriptedClient(calls, {
      download: () =>
        Effect.gen(function* () {
          calls.push("download")
          return yield* Effect.never
        }),
    })
    const fiber = yield* Effect.forkChild(synchronizationProgram([client], calls))
    yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)

    expect(calls).toEqual(["reset", "health", "download", "shutdown"])
  }),
)

function synchronizationProgram(
  clients: ReadonlyArray<ActualClient>,
  calls: string[],
  options: { retries?: number } = {},
) {
  const schedule = Schedule.max([
    Schedule.recurs(options.retries ?? 0).pipe(Schedule.map(() => Duration.zero)),
    Schedule.spaced(Duration.zero),
  ]).pipe(Schedule.setInputType<ActualError>())
  const clientQueue = [...clients]

  return Effect.gen(function* () {
    const service = yield* ActualSynchronization
    yield* service.synchronize(SNAPSHOT)
  }).pipe(
    Effect.provide(ActualSynchronization.layer),
    Effect.provideService(ActualConfigService, CONFIG),
    Effect.provideService(ActualClientFactory, {
      acquire: () => {
        const client = clientQueue.shift()
        return client
          ? Effect.succeed(client)
          : Effect.fail(
              new ActualInitializationFailure({
                cause: new Error("test client queue exhausted"),
                retryable: false,
              }),
            )
      },
    }),
    Effect.provideService(ActualFileSystem, {
      reset: () => Effect.sync(() => calls.push("reset")),
    }),
    Effect.provideService(ActualHealthCheck, {
      check: () => Effect.sync(() => calls.push("health")),
    }),
    Effect.provideService(ActualRetryPolicy, { schedule }),
  )
}

function scriptedClient(
  calls: string[],
  options: {
    transactions?: ReadonlyArray<{
      id: string
      date?: string
      notes?: string
      payee?: string | null
      imported_id?: string
    }>
    create?: ActualClient["createTransaction"]
    download?: ActualClient["downloadBudget"]
    onTransactions?: (startDate: string, endDate: string) => void
  } = {},
): ActualClient {
  return {
    downloadBudget: options.download ?? (() => Effect.sync(() => calls.push("download"))),
    getTransactions: (_accountId, startDate, endDate) =>
      Effect.sync(() => {
        calls.push("transactions")
        options.onTransactions?.(startDate, endDate)
        return options.transactions ?? []
      }),
    getPayees: () =>
      Effect.sync(() => {
        calls.push("payees")
        return [{ id: "payee-id", name: "Fintual" }]
      }),
    createTransaction:
      options.create ??
      ((_accountId, transaction) => Effect.sync(() => calls.push(`create:${transaction.date}`))),
    updateTransaction: (id) => Effect.sync(() => calls.push(`update:${id}`)),
    deleteTransaction: (id) => Effect.sync(() => calls.push(`delete:${id}`)),
    sync: () => Effect.sync(() => calls.push("sync")),
    shutdown: () => Effect.sync(() => calls.push("shutdown")),
  }
}
