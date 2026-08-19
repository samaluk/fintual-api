import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, beforeEach, expect, vi } from "vitest"

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

import type { ActualConfig } from "../env.ts"
import type { PerformanceSnapshot } from "../performance-snapshot.ts"
import { ActualClientFactory, type ActualClient } from "./actual-client.ts"

beforeEach(() => {
  actualApiMock.init.mockResolvedValue({})
  actualApiMock.downloadBudget.mockResolvedValue({})
  actualApiMock.getTransactions.mockResolvedValue([])
  actualApiMock.getPayees.mockResolvedValue([{ id: "payee-1", name: "Fintual" }])
  actualApiMock.addTransactions.mockResolvedValue({})
  actualApiMock.updateTransaction.mockResolvedValue({})
  actualApiMock.deleteTransaction.mockResolvedValue({})
  actualApiMock.sync.mockResolvedValue({})
  actualApiMock.shutdown.mockResolvedValue({})
})

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

const acquireClient = Effect.gen(function* () {
  const factory = yield* ActualClientFactory
  return yield* factory.acquire(CONFIG)
}).pipe(Effect.provide(ActualClientFactory.live))

const reconcileSnapshot = (client: ActualClient) =>
  client.reconcile(SNAPSHOT, {
    startingDate: CONFIG.startingDate,
    startingTimestamp: Date.parse(`${CONFIG.startingDate}T00:00:00Z`),
    accountId: CONFIG.fintualAccount,
    payeeName: CONFIG.payee,
  })

it.effect("reconciles by downloading budget, planning, creating transactions, and syncing", () =>
  Effect.gen(function* () {
    const client = yield* acquireClient
    const counts = yield* reconcileSnapshot(client)

    expect(counts).toEqual({ created: 1, updated: 0, deletedDuplicates: 0 })
    expect(actualApiMock.downloadBudget).toHaveBeenCalledWith("sync-id")
    expect(actualApiMock.getTransactions).toHaveBeenCalledWith(
      "account-id",
      "2026-01-01",
      expect.any(String),
    )
    expect(actualApiMock.getPayees).toHaveBeenCalled()
    expect(actualApiMock.addTransactions).toHaveBeenCalledWith("account-id", [
      expect.objectContaining({
        date: "2026-01-05",
        amount: 1200,
        payee: "payee-1",
        notes: "Variation",
        imported_id: "fintual-variation:2026-01-05",
      }),
    ])
    expect(actualApiMock.sync).toHaveBeenCalled()
  }),
)

it.effect("updates canonical existing transactions and deletes legacy duplicates", () =>
  Effect.gen(function* () {
    actualApiMock.getTransactions.mockResolvedValue([
      {
        id: "legacy-1",
        date: "2026-01-05",
        notes: "Variation",
        payee: "payee-1",
        imported_id: String(Date.parse("2026-01-05T00:00:00Z")),
      },
      {
        id: "canon-1",
        date: "2026-01-05",
        notes: "Variation",
        payee: "payee-1",
        imported_id: "fintual-variation:2026-01-05",
      },
    ])

    const client = yield* acquireClient
    const counts = yield* reconcileSnapshot(client)

    expect(counts).toEqual({ created: 0, updated: 1, deletedDuplicates: 1 })
    expect(actualApiMock.updateTransaction).toHaveBeenCalledWith(
      "canon-1",
      expect.objectContaining({ date: "2026-01-05", amount: 1200 }),
    )
    expect(actualApiMock.deleteTransaction).toHaveBeenCalledWith("legacy-1")
    expect(actualApiMock.sync).toHaveBeenCalled()
  }),
)

it.effect("decodes a legacy numeric imported id to its date even when date field is stale", () =>
  Effect.gen(function* () {
    actualApiMock.getTransactions.mockResolvedValue([
      {
        id: "txn-1",
        date: "2020-01-01",
        notes: "Variation",
        payee: "payee-1",
        imported_id: String(Date.parse("2026-01-05T00:00:00Z")),
      },
    ])

    const client = yield* acquireClient
    const counts = yield* reconcileSnapshot(client)

    expect(counts).toEqual({ created: 0, updated: 1, deletedDuplicates: 0 })
    expect(actualApiMock.updateTransaction).toHaveBeenCalledWith(
      "txn-1",
      expect.objectContaining({ date: "2026-01-05", amount: 1200 }),
    )
  }),
)

it.effect("handles missing payee gracefully and still reconciles", () =>
  Effect.gen(function* () {
    actualApiMock.getPayees.mockResolvedValue([{ id: "other-payee", name: "Someone Else" }])

    const client = yield* acquireClient
    const counts = yield* reconcileSnapshot(client)

    expect(counts).toEqual({ created: 1, updated: 0, deletedDuplicates: 0 })
    expect(actualApiMock.addTransactions).toHaveBeenCalledWith("account-id", [
      expect.objectContaining({
        date: "2026-01-05",
        payee: undefined,
      }),
    ])
  }),
)

it.effect("uses the Effect Clock for the transaction end date", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-02-03T12:00:00Z"))

    const client = yield* acquireClient
    yield* reconcileSnapshot(client)

    expect(actualApiMock.getTransactions).toHaveBeenCalledWith(
      "account-id",
      "2026-01-01",
      "2026-02-03",
    )
  }),
)

it.effect("fails with a non-retryable failure on a malformed transaction row", () =>
  Effect.gen(function* () {
    actualApiMock.getTransactions.mockResolvedValue([{ date: "2026-01-05" }])

    const client = yield* acquireClient
    const failure = yield* Effect.flip(reconcileSnapshot(client))

    expect(failure).toMatchObject({
      _tag: "ActualOperationFailure",
      operation: "get_transactions",
      retryable: false,
    })
  }),
)

it.effect("fails with a retryable failure on network failure during download", () =>
  Effect.gen(function* () {
    actualApiMock.downloadBudget.mockRejectedValue({ code: "network-failure" })

    const client = yield* acquireClient
    const failure = yield* Effect.flip(reconcileSnapshot(client))

    expect(failure).toMatchObject({
      _tag: "ActualOperationFailure",
      operation: "download_budget",
      retryable: true,
    })
  }),
)

it.effect("shuts down the Actual API cleanly", () =>
  Effect.gen(function* () {
    const client = yield* acquireClient
    yield* client.shutdown

    expect(actualApiMock.shutdown).toHaveBeenCalled()
  }),
)
