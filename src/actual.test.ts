import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { it } from "@effect/vitest"
import { Effect, Fiber, Redacted, Result } from "effect"
import { TestClock } from "effect/testing"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest"

import { ActualSynchronization } from "./actual.ts"
import { ActualClientFactory, type ActualClient } from "./actual/actual-client.ts"
import { ActualInitializationFailure, ActualOperationFailure } from "./actual/actual-error.ts"
import { ActualConfigService, type ActualConfig } from "./env.ts"
import type { PerformanceSnapshot } from "./performance-snapshot.ts"

const healthUrl = "https://actual.example.test/health"
const server = setupServer(http.get(healthUrl, () => new HttpResponse()))
beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterAll(() => server.close())

let dataDir: string
beforeEach(({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), "actual-synchronization-"))
  dataDir = directory
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
})
afterEach(() => server.resetHandlers())

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

it.effect("health checks normalize the server URL and classify HTTP failures", () =>
  Effect.gen(function* () {
    const urls: string[] = []
    server.use(
      http.get(healthUrl, ({ request }) => {
        urls.push(request.url)
        return new HttpResponse(null, { status: 503 })
      }),
    )
    const program = Effect.gen(function* () {
      const service = yield* ActualSynchronization
      yield* service.synchronize(SNAPSHOT)
    }).pipe(
      Effect.provide(ActualSynchronization.layer(dataDir)),
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
    server.use(http.get(healthUrl, () => HttpResponse.error()))
    const program = Effect.gen(function* () {
      const service = yield* ActualSynchronization
      yield* service.synchronize(SNAPSHOT)
    }).pipe(
      Effect.provide(ActualSynchronization.layer(dataDir)),
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
    const started = Promise.withResolvers<Request>()
    server.use(
      http.get(healthUrl, ({ request }) => {
        started.resolve(request)
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => resolve(new HttpResponse(null, { status: 499 })),
            {
              once: true,
            },
          )
        })
      }),
    )
    const program = Effect.gen(function* () {
      const service = yield* ActualSynchronization
      yield* service.synchronize(SNAPSHOT)
    }).pipe(
      Effect.provide(ActualSynchronization.layer(dataDir)),
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
    )
    const fiber = yield* Effect.forkChild(program)
    const request = yield* Effect.promise(() => started.promise)
    yield* TestClock.adjust("5 minutes")
    const result = yield* Effect.result(Fiber.join(fiber))

    expect(Result.isFailure(result)).toBe(true)
    expect(request.signal.aborted).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ActualHealthCheckFailure",
        retryable: true,
      })
    }
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

function synchronizationProgram(clients: ReadonlyArray<ActualClient>, calls: string[]) {
  const clientQueue = [...clients]
  server.use(
    http.get(healthUrl, () => {
      calls.push("health")
      return new HttpResponse()
    }),
  )

  return Effect.gen(function* () {
    const service = yield* ActualSynchronization
    yield* service.synchronize(SNAPSHOT)
  }).pipe(
    Effect.provide(ActualSynchronization.layer(dataDir)),
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
