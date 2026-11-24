import { once } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { arrayBuffer, text } from "node:stream/consumers"

import * as api from "@actual-app/api"
import {
  create,
  fromBinary,
  merkle,
  SyncRequestSchema,
  SyncResponseSchema,
  Timestamp,
  toBinary,
  type MessageEnvelope,
} from "@actual-app/crdt"
import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, expect, vi, type TestContext } from "vitest"

import type { ActualConfig } from "../env.ts"
import type { PerformanceSnapshot } from "../performance-snapshot.ts"
import { ActualClientFactory } from "./actual-client.ts"

const PAYEE = "Fintual"
const PASSWORD = "local-test-password"
const TOKEN = "local-test-session"
const REMOTE_BUDGET = { fileId: "budget-file", groupId: "budget-sync", name: "Test investments" }
const STARTING_DATE = "2026-01-01"
const EFFECT_TODAY = "2026-02-03"
const SDK_TODAY = "2026-03-01"
const CANONICAL_ID = "fintual-variation:2026-01-05"
const LEGACY_TIMESTAMP = String(Date.parse("2026-01-06"))

let baseBudget: Awaited<ReturnType<typeof createSeedBudget>>
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production")
  vi.setSystemTime(new Date(`${SDK_TODAY}T12:00:00`))
  baseBudget = await createSeedBudget()
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function snapshot(...dates: string[]): PerformanceSnapshot {
  return {
    balance: dates.map((date) => ({
      date: Date.parse(date),
      value: 1_100,
      difference: 50,
      real_difference: 12.49,
    })),
    deposits: [],
  }
}

it.effect("downloads the seeded budget and publishes a variation a fresh client can read", (test) =>
  Effect.gen(function* () {
    const budget = yield* setupBudget(test)
    const client = yield* acquireClient(budget.config, budget.dataDir)

    const counts = yield* client.reconcile(snapshot("2025-12-31", "2026-01-05"), budget.options)

    expect(counts).toEqual({ created: 1, updated: 0, deletedDuplicates: 0 })
    expect(budget.server.hasSyncedChanges).toBe(true)
    yield* client.shutdown

    const rows = yield* Effect.promise(() => budget.readSyncedTransactions())
    expect(rows).toMatchObject([
      {
        date: "2026-01-05",
        amount: 1200,
        payee: budget.payeeId,
        notes: "Variation",
        imported_id: "fintual-variation:2026-01-05",
      },
    ])
  }),
)

it.effect("updates canonical and stale-date legacy rows and deletes only the duplicate", (test) =>
  Effect.gen(function* () {
    const budget = yield* setupBudget(test, { account: "legacy" })
    const client = yield* acquireClient(budget.config, budget.dataDir)
    const counts = yield* client.reconcile(snapshot("2026-01-05", "2026-01-06"), budget.options)
    yield* client.shutdown

    const rows = yield* Effect.promise(() => budget.readSyncedTransactions())
    expect(counts).toEqual({ created: 0, updated: 2, deletedDuplicates: 1 })
    expect(rows).toHaveLength(3)
    for (const [previousId, date] of [
      [CANONICAL_ID, "2026-01-05"],
      [LEGACY_TIMESTAMP, "2026-01-06"],
    ]) {
      const original = baseBudget.legacyRows.find((row) => row.imported_id === previousId)
      expect(original).toBeDefined()
      expect(rows.find((row) => row.id === original?.id)).toMatchObject({
        date,
        amount: 1200,
        imported_id: `fintual-variation:${date}`,
      })
    }
    expect(rows.find((row) => row.notes === "Unrelated deposit")?.amount).toBe(300)
  }),
)

it.effect("leaves future rows outside the Effect Clock window untouched", (test) =>
  Effect.gen(function* () {
    const budget = yield* setupBudget(test, { account: "future" })
    const client = yield* acquireClient(budget.config, budget.dataDir)

    const counts = yield* client.reconcile(snapshot("2026-01-05"), budget.options)

    expect(counts).toEqual({ created: 1, updated: 0, deletedDuplicates: 0 })
    const rows = yield* Effect.promise(() =>
      api.getTransactions(budget.config.fintualAccount, STARTING_DATE, "2026-02-04"),
    )
    expect(rows.find((row) => row.date === "2026-02-04")?.amount).toBe(100)
    yield* client.shutdown
  }),
)

it.effect("creates a variation without a payee when the configured name is absent", (test) =>
  Effect.gen(function* () {
    const budget = yield* setupBudget(test)
    const client = yield* acquireClient(budget.config, budget.dataDir)

    const counts = yield* client.reconcile(snapshot("2026-01-05"), {
      ...budget.options,
      payeeName: "No such payee",
    })

    expect(counts).toEqual({ created: 1, updated: 0, deletedDuplicates: 0 })
    const rows = yield* Effect.promise(() =>
      api.getTransactions(budget.config.fintualAccount, STARTING_DATE, EFFECT_TODAY),
    )
    expect(rows).toMatchObject([{ date: "2026-01-05", payee: null }])
    yield* client.shutdown
  }),
)

it.effect("rejects an invalid starting date before looking up the budget", (test) =>
  Effect.gen(function* () {
    const budget = yield* setupBudget(test)
    const client = yield* acquireClient(budget.config, budget.dataDir)
    const failure = yield* Effect.flip(
      client.reconcile(snapshot("2026-01-05"), { ...budget.options, startingDate: "not-a-date" }),
    )

    expect(failure).toMatchObject({
      _tag: "ActualInvalidStartingDate",
      startingDate: "not-a-date",
      retryable: false,
    })
    expect(budget.server.requests).not.toContain("GET /sync/list-user-files")
    yield* client.shutdown
  }),
)

it.effect("rejects a malformed imported ID read from the downloaded database", (test) =>
  Effect.gen(function* () {
    const budget = yield* setupBudget(test, { account: "malformed" })
    const client = yield* acquireClient(budget.config, budget.dataDir)
    const failure = yield* Effect.flip(client.reconcile(snapshot("2026-01-05"), budget.options))

    expect(failure).toMatchObject({
      _tag: "ActualOperationFailure",
      operation: "get_transactions",
      cause: { _tag: "SchemaError" },
      retryable: false,
    })
    expect(budget.server.hasSyncedChanges).toBe(false)
    yield* client.shutdown
  }),
)

it.effect.each([
  { failure: "file-list", syncId: REMOTE_BUDGET.groupId, code: "network-failure", retryable: true },
  { failure: undefined, syncId: "unknown-sync-id", code: "budget-not-found", retryable: false },
] satisfies ReadonlyArray<{
  failure?: ServerFailure
  syncId: string
  code: string
  retryable: boolean
}>)("maps a download failure with SDK code $code", ({ failure, syncId, code, retryable }, test) =>
  Effect.gen(function* () {
    const budget = yield* setupBudget(test, { failure })
    const client = yield* acquireClient({ ...budget.config, syncId }, budget.dataDir)
    const error = yield* Effect.flip(client.reconcile(snapshot("2026-01-05"), budget.options))

    expect(error).toMatchObject({
      _tag: "ActualOperationFailure",
      operation: "download_budget",
      cause: { code },
      retryable,
    })
    yield* client.shutdown
  }),
)

it.effect("reports a retryable sync failure when the server cannot accept writes", (test) =>
  Effect.gen(function* () {
    const budget = yield* setupBudget(test, { failure: "sync-write" })
    const client = yield* acquireClient(budget.config, budget.dataDir)
    const failure = yield* Effect.flip(client.reconcile(snapshot("2026-01-05"), budget.options))

    expect(failure).toMatchObject({
      _tag: "ActualOperationFailure",
      operation: "sync",
      cause: { code: "network-failure" },
      retryable: true,
    })
    expect(budget.server.hasSyncedChanges).toBe(false)
    yield* client.shutdown
  }),
)

it.effect("reports rejected credentials as a non-retryable initialization error", (test) =>
  Effect.gen(function* () {
    const budget = yield* setupBudget(test)
    const config = { ...budget.config, password: Redacted.make("wrong-password") }
    const failure = yield* Effect.flip(acquireClient(config, budget.dataDir))

    expect(failure).toMatchObject({
      _tag: "ActualInitializationFailure",
      cause: { code: "invalid-password" },
      retryable: false,
    })
  }),
)

const acquireClient = Effect.fnUntraced(function* (config: ActualConfig, dataDir: string) {
  const factory = yield* ActualClientFactory
  return yield* factory.acquire(config, dataDir)
}, Effect.provide(ActualClientFactory.live))

async function createSeedBudget() {
  const dataDir = await mkdtemp(join(tmpdir(), "actual-sdk-seed-"))
  try {
    const sdk = await api.init({ dataDir, verbose: false })
    expect(
      await sdk.send("create-budget", { budgetName: REMOTE_BUDGET.name, avoidUpload: true }),
    ).toEqual({})
    await sdk.send("save-prefs", { lastScheduleRun: SDK_TODAY })
    const payeeId = await api.createPayee({ name: PAYEE })
    const accounts = await seedAccounts(payeeId)
    const legacyRows = await api.getTransactions(accounts.legacy, STARTING_DATE, EFFECT_TODAY)
    sdk.db.runQuery("UPDATE transactions SET financial_id = X'FF' WHERE acct = ?", [
      accounts.malformed,
    ])
    return { archive: await api.exportBudget(), accounts, payeeId, legacyRows }
  } finally {
    try {
      await api.shutdown()
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }
}

async function seedAccounts(payeeId: string) {
  const accounts = {
    empty: await api.createAccount({ name: "No previous variations", offbudget: true }),
    legacy: await api.createAccount({ name: "Legacy variations", offbudget: true }),
    future: await api.createAccount({ name: "Future variation", offbudget: true }),
    malformed: await api.createAccount({ name: "Malformed imported ID", offbudget: true }),
  }
  await api.addTransactions(accounts.legacy, [
    { date: "2026-01-05", amount: 90, notes: "Variation", payee: payeeId },
    {
      date: "2026-01-05",
      amount: 100,
      notes: "Variation",
      payee: payeeId,
      imported_id: CANONICAL_ID,
    },
    {
      date: "2026-01-02",
      amount: 110,
      notes: "Variation",
      payee: payeeId,
      imported_id: LEGACY_TIMESTAMP,
    },
    { date: "2026-01-06", amount: 300, notes: "Unrelated deposit", payee: payeeId },
  ])
  await api.addTransactions(accounts.future, [
    {
      date: "2026-02-04",
      amount: 100,
      notes: "Variation",
      payee: payeeId,
      imported_id: CANONICAL_ID,
    },
  ])
  await api.addTransactions(accounts.malformed, [{ date: "2026-01-05", amount: 100 }])
  return accounts
}

interface BudgetOptions {
  readonly account?: keyof Awaited<ReturnType<typeof seedAccounts>>
  readonly failure?: ServerFailure
}

const setupBudget = Effect.fnUntraced(function* (test: TestContext, options: BudgetOptions = {}) {
  yield* TestClock.setTime(Date.parse(`${EFFECT_TODAY}T12:00:00Z`))
  return yield* Effect.promise(() => buildBudget(test, options))
})

async function buildBudget(test: TestContext, { account = "empty", failure }: BudgetOptions) {
  const root = await mkdtemp(join(tmpdir(), "actual-sdk-"))
  let server: Awaited<ReturnType<typeof startBudgetServer>> | undefined
  test.onTestFinished(async () => {
    try {
      await api.shutdown()
    } finally {
      try {
        await server?.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  const dataDir = join(root, "client")
  await mkdir(dataDir)
  const { accounts, payeeId } = baseBudget
  const accountId = accounts[account]
  server = await startBudgetServer(baseBudget.archive, failure)
  const config: ActualConfig = {
    serverUrl: server.url,
    password: Redacted.make(PASSWORD),
    syncId: REMOTE_BUDGET.groupId,
    fintualAccount: accountId,
    startingDate: STARTING_DATE,
    payee: PAYEE,
  }
  return {
    config,
    options: { startingDate: STARTING_DATE, accountId, payeeName: PAYEE },
    dataDir,
    payeeId,
    server,
    async readSyncedTransactions() {
      const freshDir = await mkdtemp(join(root, "reader-"))
      await api.init({
        dataDir: freshDir,
        serverURL: config.serverUrl,
        password: PASSWORD,
        verbose: false,
      })
      try {
        await api.downloadBudget(config.syncId)
        return await api.getTransactions(accountId, STARTING_DATE, EFFECT_TODAY)
      } finally {
        await api.shutdown()
      }
    },
  }
}

type ServerFailure = "file-list" | "sync-write"

async function startBudgetServer(archive: Uint8Array, failure: ServerFailure | undefined) {
  const requests: string[] = []
  const errors: unknown[] = []
  const syncMessages = new Map<string, MessageEnvelope>()
  let syncMerkle: Parameters<typeof merkle.insert>[0] = {}
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      errors.push(error)
      response.writeHead(500).end()
    })
  })

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = `${request.method} ${request.url}`
    requests.push(route)
    if (route === "POST /account/login") {
      await handleLogin(request, response)
      return
    }
    if (route === "POST /account/logout") {
      const session: unknown = JSON.parse(await text(request))
      expect(session).toEqual({ token: TOKEN })
      sendJson(response, { status: "ok", data: null })
      return
    }

    expect(request.headers["x-actual-token"]).toBe(TOKEN)
    switch (route) {
      case "GET /sync/list-user-files":
        if (failure === "file-list") request.socket.destroy()
        else sendJson(response, { status: "ok", data: [REMOTE_BUDGET] })
        return
      case "GET /sync/get-user-file-info":
        expect(request.headers["x-actual-file-id"]).toBe(REMOTE_BUDGET.fileId)
        sendJson(response, { status: "ok", data: REMOTE_BUDGET })
        return
      case "GET /sync/download-user-file":
        expect(request.headers["x-actual-file-id"]).toBe(REMOTE_BUDGET.fileId)
        response.writeHead(200, { "Content-Type": "application/zip" }).end(archive)
        return
      case "POST /sync/sync":
        await handleSync(request, response)
        return
      default:
        throw new Error(`Unexpected Actual request: ${route}`)
    }
  }

  async function handleSync(request: IncomingMessage, response: ServerResponse): Promise<void> {
    expect(request.headers["content-type"]).toBe("application/actual-sync")
    const { fileId, groupId, since, messages } = fromBinary(
      SyncRequestSchema,
      new Uint8Array(await arrayBuffer(request)),
    )
    expect({ fileId, groupId }).toEqual({
      fileId: REMOTE_BUDGET.fileId,
      groupId: REMOTE_BUDGET.groupId,
    })
    if (failure === "sync-write" && messages.length > 0) {
      request.socket.destroy()
      return
    }

    const sent = new Set(messages.map((message) => message.timestamp))
    const incoming = [...syncMessages.values()].filter(
      (message) => message.timestamp > since && !sent.has(message.timestamp),
    )
    for (const message of messages) {
      if (!syncMessages.has(message.timestamp)) {
        const timestamp = Timestamp.parse(message.timestamp)
        if (!timestamp) throw new Error(`Invalid sync timestamp: ${message.timestamp}`)
        syncMessages.set(message.timestamp, message)
        syncMerkle = merkle.insert(syncMerkle, timestamp)
      }
    }
    const payload = create(SyncResponseSchema, {
      messages: incoming,
      merkle: JSON.stringify(syncMerkle),
    })
    response
      .writeHead(200, { "Content-Type": "application/actual-sync" })
      .end(toBinary(SyncResponseSchema, payload))
  }

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get hasSyncedChanges() {
      return syncMessages.size > 0
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
      expect(errors).toEqual([])
    },
  }
}

async function handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const credentials: unknown = JSON.parse(await text(request))
  if (
    credentials &&
    typeof credentials === "object" &&
    "password" in credentials &&
    credentials.password === PASSWORD
  ) {
    sendJson(response, { status: "ok", data: { token: TOKEN } })
  } else {
    response.statusCode = 401
    sendJson(response, { status: "error", reason: "invalid-password" })
  }
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.setHeader("Content-Type", "application/json").end(JSON.stringify(body))
}
