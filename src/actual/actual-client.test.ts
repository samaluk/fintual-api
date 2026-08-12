import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { afterEach, beforeEach, expect, vi } from "vitest"

const actualApiMock = vi.hoisted(() => ({
  init: vi.fn(),
  getTransactions: vi.fn(),
  getPayees: vi.fn(),
}))

vi.mock("@actual-app/api", () => actualApiMock)

import type { ActualConfig } from "../env.ts"
import { ActualClientFactory } from "./actual-client.ts"

beforeEach(() => {
  actualApiMock.init.mockResolvedValue({})
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

const acquireClient = Effect.gen(function* () {
  const factory = yield* ActualClientFactory
  return yield* factory.acquire(CONFIG)
}).pipe(Effect.provide(ActualClientFactory.live))

const canonicalImportedId = (date: string) => `fintual-variation:${date}`
const numericImportedId = (date: string) => String(Date.parse(`${date}T00:00:00Z`))

it.effect("decodes a canonical transaction row into a clean domain value", () =>
  Effect.gen(function* () {
    actualApiMock.getTransactions.mockResolvedValue([
      {
        id: "txn-1",
        date: "2026-01-05",
        notes: "Variation",
        payee: "payee-1",
        imported_id: canonicalImportedId("2026-01-05"),
        account: "account-id",
        amount: 1200,
        category: "cat-1",
      },
    ])

    const client = yield* acquireClient
    const transactions = yield* client.getTransactions("account-id", "2026-01-01", "2026-01-31")

    expect(transactions).toEqual([
      {
        id: "txn-1",
        date: "2026-01-05",
        notes: "Variation",
        payee: "payee-1",
        imported_id: canonicalImportedId("2026-01-05"),
      },
    ])
  }),
)

it.effect(
  "decodes a legacy numeric imported id to its date even when the date field is stale",
  () =>
    Effect.gen(function* () {
      actualApiMock.getTransactions.mockResolvedValue([
        { id: "txn-1", date: "2020-01-01", imported_id: numericImportedId("2026-01-05") },
      ])

      const client = yield* acquireClient
      const transactions = yield* client.getTransactions("account-id", "2026-01-01", "2026-01-31")

      expect(transactions).toEqual([
        { id: "txn-1", date: "2026-01-05", imported_id: numericImportedId("2026-01-05") },
      ])
    }),
)

it.effect("falls back to the ISO date field when no imported id carries a date", () =>
  Effect.gen(function* () {
    actualApiMock.getTransactions.mockResolvedValue([{ id: "txn-1", date: "2026-01-05" }])

    const client = yield* acquireClient
    const transactions = yield* client.getTransactions("account-id", "2026-01-01", "2026-01-31")

    expect(transactions).toEqual([{ id: "txn-1", date: "2026-01-05" }])
  }),
)

it.effect("falls back to the date field when the prefixed imported id has no valid date", () =>
  Effect.gen(function* () {
    actualApiMock.getTransactions.mockResolvedValue([
      { id: "txn-1", date: "2026-01-06", imported_id: "fintual-variation:not-a-date" },
    ])

    const client = yield* acquireClient
    const transactions = yield* client.getTransactions("account-id", "2026-01-01", "2026-01-31")

    expect(transactions).toEqual([
      { id: "txn-1", date: "2026-01-06", imported_id: "fintual-variation:not-a-date" },
    ])
  }),
)

it.effect("drops rows whose date cannot be derived", () =>
  Effect.gen(function* () {
    actualApiMock.getTransactions.mockResolvedValue([
      { id: "txn-1", date: "not-a-date", imported_id: "not-a-date" },
      { id: "txn-2" },
    ])

    const client = yield* acquireClient
    const transactions = yield* client.getTransactions("account-id", "2026-01-01", "2026-01-31")

    expect(transactions).toEqual([])
  }),
)

it.effect("coalesces null SDK fields into well-formed domain values", () =>
  Effect.gen(function* () {
    actualApiMock.getTransactions.mockResolvedValue([
      {
        id: "txn-1",
        date: null,
        notes: null,
        payee: null,
        imported_id: canonicalImportedId("2026-01-05"),
      },
    ])

    const client = yield* acquireClient
    const transactions = yield* client.getTransactions("account-id", "2026-01-01", "2026-01-31")

    expect(transactions).toEqual([
      {
        id: "txn-1",
        date: "2026-01-05",
        payee: null,
        imported_id: canonicalImportedId("2026-01-05"),
      },
    ])
  }),
)

it.effect("fails with a non-retryable read failure on a malformed row", () =>
  Effect.gen(function* () {
    actualApiMock.getTransactions.mockResolvedValue([{ date: "2026-01-05" }])

    const client = yield* acquireClient
    const failure = yield* Effect.flip(
      client.getTransactions("account-id", "2026-01-01", "2026-01-31"),
    )

    expect(failure).toMatchObject({
      _tag: "ActualTransactionsReadFailure",
      retryable: false,
    })
  }),
)

it.effect("decodes payee rows into clean values", () =>
  Effect.gen(function* () {
    actualApiMock.getPayees.mockResolvedValue([
      { id: "payee-1", name: "Fintual", transfer_acct: "acct-1", tombstone: false },
    ])

    const client = yield* acquireClient
    const payees = yield* client.getPayees

    expect(payees).toEqual([{ id: "payee-1", name: "Fintual" }])
  }),
)
