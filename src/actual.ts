import * as fs from "node:fs"
import * as api from "@actual-app/api"
import { Effect } from "effect"
import * as v from "valibot"
import { log, sleep, tryPromise, trySync, warn } from "./effect.ts"
import { getEnv } from "./env.ts"
import { getErrorMessage } from "./log.ts"

const SERVER_URL = getEnv("ACTUAL_SERVER_URL")
const PASSWORD = getEnv("ACTUAL_PASSWORD")
const SYNC_ID = getEnv("ACTUAL_SYNC_ID")
const FINTUAL_ACCOUNT = getEnv("ACTUAL_FINTUAL_ACCOUNT")
const STARTING_DATE = getEnv("ACTUAL_STARTING_DATE", getEnv("STARTING_DATE", "2024-03-01"))
const PAYEE = getEnv("ACTUAL_PAYEE", "Fintual")

const ACTUAL_DATA_DIR = "./tmp/actual-data"
const BALANCE_FILE_PATH = "./tmp/fintual-data/balance-2.json"
const MAX_SYNC_ATTEMPTS = 5
const INITIAL_RETRY_DELAY_MS = 5000
const MAX_RETRY_DELAY_MS = 60000
const RETRY_JITTER_RATIO = 0.2

const balanceFileSchema = v.object({
  balance: v.array(
    v.object({
      date: v.number(),
      value: v.number(),
      difference: v.number(),
      real_difference: v.number(),
    }),
  ),
  deposits: v.array(
    v.object({
      date: v.number(),
      value: v.number(),
      difference: v.number(),
    }),
  ),
})

type BalanceEntry = v.InferOutput<typeof balanceFileSchema>["balance"][number]
type ActualInitConfig = Parameters<typeof api.init>[0]

interface VariationTransactionFields {
  date: string
  amount: number
  payee: string | undefined
  notes: string
  imported_id: string
  cleared: boolean
}

interface SyncCounts {
  created: number
  updated: number
}

export const main: Effect.Effect<void, Error> = Effect.gen(function* () {
  yield* assertActualEnvConfigured()
  const syncCounts = yield* runActualSyncWithRetry(1)
  yield* log(
    `Actual sync finished. Created ${syncCounts.created} transactions and updated ${syncCounts.updated}.`,
  )
})

function assertActualEnvConfigured(): Effect.Effect<void, Error> {
  if (SERVER_URL && PASSWORD && SYNC_ID && FINTUAL_ACCOUNT && STARTING_DATE && PAYEE) {
    return Effect.void
  }

  return Effect.fail(new Error("Missing Actual configuration environment variables"))
}

function runActualSyncWithRetry(attempt: number): Effect.Effect<SyncCounts, Error> {
  return Effect.catchAll(runActualSyncAttempt(), (cause) => {
    const shouldRetry = isRetryableActualError(cause) && attempt < MAX_SYNC_ATTEMPTS

    if (!shouldRetry) {
      return Effect.fail(cause)
    }

    const retryDelayMs = getRetryDelayMs(attempt)
    return Effect.gen(function* () {
      yield* warn(
        `Actual sync attempt ${attempt} failed with a retryable error: ${getErrorMessage(cause)}. Retrying in ${Math.round(retryDelayMs / 1000)}s.`,
      )
      yield* sleep(retryDelayMs)
      return yield* runActualSyncWithRetry(attempt + 1)
    })
  })
}

function runActualSyncAttempt(): Effect.Effect<SyncCounts, Error> {
  return Effect.gen(function* () {
    yield* resetDataDirectory()
    yield* assertActualServerReachable()

    yield* tryPromise({
      try: () =>
        api.init({
          dataDir: ACTUAL_DATA_DIR,
          serverURL: SERVER_URL,
          password: PASSWORD,
        } satisfies ActualInitConfig),
      catch: "Failed to initialize Actual API",
    })

    return yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* tryPromise({
          try: () => api.downloadBudget(SYNC_ID),
          catch: "Failed to download Actual budget",
        })
        return yield* syncDailyVariationTransactions()
      }),
      Effect.ignore(
        tryPromise({
          try: () => api.shutdown(),
          catch: "Failed to shutdown Actual API",
        }),
      ),
    )
  })
}

function syncDailyVariationTransactions(): Effect.Effect<SyncCounts, Error> {
  return Effect.gen(function* () {
    const endingDate = getTodayIsoDate()
    const transactions = yield* tryPromise({
      try: () => api.getTransactions(FINTUAL_ACCOUNT, STARTING_DATE, endingDate),
      catch: "Failed to fetch Actual transactions",
    })

    const balanceEntries = yield* loadBalanceEntries()
    const payeeId = yield* getPayeeId()
    const syncCounts: SyncCounts = {
      created: 0,
      updated: 0,
    }

    for (const balanceEntry of balanceEntries) {
      const transaction = createVariationTransaction(balanceEntry, payeeId)
      const existingTransaction = transactions.find(
        (candidate) => candidate.imported_id === transaction.imported_id,
      )

      if (!existingTransaction) {
        yield* tryPromise({
          try: () => api.addTransactions(FINTUAL_ACCOUNT, [transaction]),
          catch: "Failed to add Actual transaction",
        })
        syncCounts.created += 1
        continue
      }

      yield* tryPromise({
        try: () => api.updateTransaction(existingTransaction.id, transaction),
        catch: "Failed to update Actual transaction",
      })
      syncCounts.updated += 1
    }

    return syncCounts
  })
}

function resetDataDirectory(): Effect.Effect<void, Error> {
  return trySync({
    try: () => {
      fs.rmSync(ACTUAL_DATA_DIR, { recursive: true, force: true })
      fs.mkdirSync(ACTUAL_DATA_DIR, { recursive: true })
    },
    catch: "Failed to reset Actual data directory",
  })
}

function loadBalanceEntries(): Effect.Effect<BalanceEntry[], Error> {
  return Effect.gen(function* () {
    const parsedFile = yield* trySync({
      try: () => JSON.parse(fs.readFileSync(BALANCE_FILE_PATH, "utf-8")) as unknown,
      catch: "Failed to load Fintual balance file",
    })
    const validation = v.safeParse(balanceFileSchema, parsedFile)

    if (!validation.success) {
      yield* log("Balance file is invalid")
      return []
    }

    const startingTimestamp = Date.parse(STARTING_DATE)
    return validation.output.balance.filter((entry) => entry.date >= startingTimestamp)
  })
}

function createVariationTransaction(
  balanceEntry: BalanceEntry,
  payeeId: string | undefined,
): VariationTransactionFields {
  return {
    date: toIsoDate(balanceEntry.date),
    amount: Math.round(Math.round(balanceEntry.real_difference) * 100),
    payee: payeeId,
    notes: "Variation",
    imported_id: String(balanceEntry.date),
    cleared: true,
  }
}

function getPayeeId(): Effect.Effect<string | undefined, Error> {
  return Effect.gen(function* () {
    const payees = yield* tryPromise({
      try: () => api.getPayees(),
      catch: "Failed to fetch Actual payees",
    })
    const payee = payees.find((candidate) => candidate.name === PAYEE)

    if (!payee) {
      yield* log("Configured payee not found")
      return undefined
    }

    return payee.id
  })
}

function getTodayIsoDate(): string {
  return new Date().toISOString().split("T")[0]
}

function toIsoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[0]
}

function isRetryableActualError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = `${error.message}\n${error.stack ?? ""}`.toLowerCase()
    return (
      message.includes("network-failure") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("eai_again") ||
      message.includes("etimedout") ||
      message.includes("fetch failed") ||
      message.includes("download-budget")
    )
  }

  if (!isRecord(error)) {
    return false
  }

  return error.type === "PostError" && error.reason === "network-failure"
}

function assertActualServerReachable(): Effect.Effect<void, Error> {
  const normalizedBaseUrl = SERVER_URL.endsWith("/") ? SERVER_URL.slice(0, -1) : SERVER_URL
  const healthUrl = `${normalizedBaseUrl}/health`

  return Effect.gen(function* () {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    const response = yield* Effect.ensuring(
      tryPromise({
        try: () =>
          fetch(healthUrl, {
            method: "GET",
            signal: controller.signal,
          }),
        catch: (cause) => `Actual server is unreachable at ${healthUrl}: ${getErrorMessage(cause)}`,
      }),
      Effect.sync(() => clearTimeout(timeout)),
    )

    if (response.ok) {
      return
    }

    return yield* Effect.fail(
      new Error(
        `Actual server is unreachable at ${healthUrl}: health endpoint returned HTTP ${response.status}`,
      ),
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getRetryDelayMs(attempt: number): number {
  const exponentialDelayMs = Math.min(
    INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
    MAX_RETRY_DELAY_MS,
  )
  const jitterRangeMs = Math.round(exponentialDelayMs * RETRY_JITTER_RATIO)
  const jitterOffsetMs = Math.floor(Math.random() * (jitterRangeMs * 2 + 1)) - jitterRangeMs

  return Math.max(1000, exponentialDelayMs + jitterOffsetMs)
}
