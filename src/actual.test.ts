import { it } from "@effect/vitest"
import { Effect, Fiber, Redacted, Result } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
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

import { ActualSynchronization } from "./actual.ts"
import { ActualClientFactory, type ActualClient } from "./actual/actual-client.ts"
import {
  ActualInitializationFailure,
  ActualInvalidStartingDate,
  ActualOperationFailure,
} from "./actual/actual-error.ts"
import { ActualConfigService, type ActualConfig } from "./env.ts"
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

    expect(calls).toEqual(["health", "reconcile", "shutdown"])
  }),
)

it.effect("retries a failed mutation as a fresh Synchronization Attempt", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const firstAttempt = scriptedClient(calls, {
      reconcile: () =>
        Effect.gen(function* () {
          calls.push("reconcile")
          return yield* new ActualOperationFailure({
            operation: "create_transaction",
            cause: { code: "network-failure" },
            retryable: true,
          })
        }),
    })
    const secondAttempt = scriptedClient(calls)

    const fiber = yield* Effect.forkChild(
      synchronizationProgram([firstAttempt, secondAttempt], calls),
    )
    yield* TestClock.adjust("10 seconds")
    yield* Fiber.join(fiber)

    expect(calls).toEqual(["health", "reconcile", "shutdown", "health", "reconcile", "shutdown"])
  }),
)

it.effect("does not retry a non-retryable Actual failure", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const client: ActualClient = {
      ...scriptedClient(calls),
      reconcile: () =>
        Effect.gen(function* () {
          calls.push("reconcile")
          return yield* new ActualOperationFailure({
            operation: "download_budget",
            cause: { code: "budget-not-found" },
            retryable: false,
          })
        }),
    }

    const error = yield* Effect.flip(synchronizationProgram([client], calls))

    expect(error).toMatchObject({
      _tag: "ActualOperationFailure",
      operation: "download_budget",
      retryable: false,
    })
    expect(calls).toEqual(["health", "reconcile", "shutdown"])
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
        return yield* client.reconcile(SNAPSHOT, {
          startingDate: CONFIG.startingDate,
          accountId: CONFIG.fintualAccount,
          payeeName: CONFIG.payee,
        })
      }).pipe(Effect.provide(ActualClientFactory.live)),
    )

    expect(Result.isFailure(result)).toBe(true)
    expect(actualApiMock.init).toHaveBeenCalledWith(expect.objectContaining({ password: "secret" }))
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ActualOperationFailure",
        operation: "download_budget",
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
      const service = yield* ActualSynchronization
      yield* service.synchronize(SNAPSHOT)
    }).pipe(
      Effect.provide(ActualSynchronization.layer),
      Effect.provideService(ActualConfigService, CONFIG),
      Effect.provideService(ActualClientFactory, {
        acquire: () =>
          Effect.fail(
            new ActualInitializationFailure({
              cause: new Error("should not acquire client on health failure"),
              retryable: false,
            }),
          ),
      }),
      Effect.provideService(FetchHttpClient.Fetch, fetchRequest),
    )

    const fiber = yield* Effect.forkChild(program)
    yield* TestClock.adjust("5 minutes")
    const error = yield* Effect.flip(Fiber.join(fiber))

    expect(error).toMatchObject({
      _tag: "ActualHealthCheckFailure",
      status: 503,
      retryable: true,
      url: "https://actual.example.test/health",
    })
    expect(urls[0]).toBe("https://actual.example.test/health")
  }),
)

it.effect("health checks map transport failures to a retryable failure", () =>
  Effect.gen(function* () {
    const fetchRequest: typeof globalThis.fetch = async () => {
      throw new TypeError("network down")
    }
    const program = Effect.gen(function* () {
      const service = yield* ActualSynchronization
      yield* service.synchronize(SNAPSHOT)
    }).pipe(
      Effect.provide(ActualSynchronization.layer),
      Effect.provideService(ActualConfigService, CONFIG),
      Effect.provideService(ActualClientFactory, {
        acquire: () =>
          Effect.fail(
            new ActualInitializationFailure({
              cause: new Error("should not acquire client on health failure"),
              retryable: false,
            }),
          ),
      }),
      Effect.provideService(FetchHttpClient.Fetch, fetchRequest),
    )

    const fiber = yield* Effect.forkChild(program)
    yield* TestClock.adjust("5 minutes")
    const error = yield* Effect.flip(Fiber.join(fiber))

    expect(error).toMatchObject({
      _tag: "ActualHealthCheckFailure",
      url: "https://actual.example.test/health",
      retryable: true,
    })
  }),
)

it.effect("health-check timeout is controlled by the Effect Clock", () =>
  Effect.gen(function* () {
    const fetchRequest: typeof globalThis.fetch = async () => new Promise<Response>(() => {})
    const program = Effect.gen(function* () {
      const service = yield* ActualSynchronization
      yield* service.synchronize(SNAPSHOT)
    }).pipe(
      Effect.provide(ActualSynchronization.layer),
      Effect.provideService(ActualConfigService, CONFIG),
      Effect.provideService(ActualClientFactory, {
        acquire: () =>
          Effect.fail(
            new ActualInitializationFailure({
              cause: new Error("should not acquire client on health failure"),
              retryable: false,
            }),
          ),
      }),
      Effect.provideService(FetchHttpClient.Fetch, fetchRequest),
    )
    const fiber = yield* Effect.forkChild(program)
    yield* TestClock.adjust("5 minutes")
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

it.effect("rejects an invalid starting date with a non-retryable failure", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const client = scriptedClient(calls, {
      reconcile: (_snapshot, options) =>
        options.startingDate === "not-a-date"
          ? Effect.fail(
              new ActualInvalidStartingDate({
                startingDate: options.startingDate,
                retryable: false,
              }),
            )
          : Effect.succeed({ created: 1, updated: 0, deletedDuplicates: 0 }),
    })
    const invalidConfig = { ...CONFIG, startingDate: "not-a-date" }

    const error = yield* Effect.flip(
      Effect.gen(function* () {
        const service = yield* ActualSynchronization
        yield* service.synchronize(SNAPSHOT)
      }).pipe(
        Effect.provide(ActualSynchronization.layer),
        Effect.provideService(ActualConfigService, invalidConfig),
        Effect.provideService(ActualClientFactory, {
          acquire: () => Effect.succeed(client),
        }),
        Effect.provideService(FetchHttpClient.Fetch, async () => new Response("", { status: 200 })),
      ),
    )

    expect(error).toMatchObject({
      _tag: "ActualInvalidStartingDate",
      startingDate: "not-a-date",
      retryable: false,
    })
  }),
)

it.effect("shuts down the scoped Actual session when the workflow is interrupted", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    let resolveReconcileStarted!: () => void
    const reconcileStarted = new Promise<void>((resolve) => {
      resolveReconcileStarted = resolve
    })
    const client = scriptedClient(calls, {
      reconcile: () =>
        Effect.gen(function* () {
          calls.push("reconcile")
          resolveReconcileStarted()
          return yield* Effect.never
        }),
    })
    const fiber = yield* Effect.forkChild(synchronizationProgram([client], calls))
    yield* Effect.promise(() => reconcileStarted)
    yield* Fiber.interrupt(fiber)

    expect(calls).toEqual(["health", "reconcile", "shutdown"])
  }),
)

function synchronizationProgram(
  clients: ReadonlyArray<ActualClient>,
  calls: string[],
  fetchRequest?: typeof globalThis.fetch,
) {
  const clientQueue = [...clients]
  const defaultFetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith("/health")) {
      calls.push("health")
      return new Response("", { status: 200 })
    }
    return new Response("", { status: 200 })
  }

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
    Effect.provideService(FetchHttpClient.Fetch, fetchRequest ?? defaultFetch),
  )
}

function scriptedClient(
  calls: string[],
  options: {
    reconcile?: ActualClient["reconcile"]
    shutdown?: ActualClient["shutdown"]
  } = {},
): ActualClient {
  return {
    reconcile:
      options.reconcile ??
      ((_snapshot, _opts) =>
        Effect.sync(() => {
          calls.push("reconcile")
          return { created: 1, updated: 0, deletedDuplicates: 0 }
        })),
    shutdown:
      options.shutdown ??
      Effect.sync(() => {
        calls.push("shutdown")
      }),
  }
}
