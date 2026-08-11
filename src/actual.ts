import * as fs from "node:fs"
import * as api from "@actual-app/api"
import { Effect } from "effect"
import * as v from "valibot"
import { log, sleep, tryPromise, trySync, warn } from "./effect.ts"
import type { ActualConfig } from "./env.ts"
import { getErrorMessage } from "./log.ts"
import { planReconciliation } from "./actual/reconciliation-policy.ts"

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

interface SyncCounts {
  created: number
  updated: number
  deletedDuplicates: number
}

export function main(config: ActualConfig): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const syncCounts = yield* runActualSyncWithRetry(config, 1)
    yield* log(
      `Actual sync finished. Created ${syncCounts.created} transactions, updated ${syncCounts.updated}, and deleted ${syncCounts.deletedDuplicates} duplicates.`,
    )
  })
}

function runActualSyncWithRetry(
  config: ActualConfig,
  attempt: number,
): Effect.Effect<SyncCounts, Error> {
  return Effect.catch(runActualSyncAttempt(config), (cause) => {
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
      return yield* runActualSyncWithRetry(config, attempt + 1)
    })
  })
}

function runActualSyncAttempt(config: ActualConfig): Effect.Effect<SyncCounts, Error> {
  return Effect.gen(function* () {
    yield* resetDataDirectory()
    yield* assertActualServerReachable(config)

    yield* tryPromise({
      try: () =>
        api.init({
          dataDir: ACTUAL_DATA_DIR,
          serverURL: config.serverUrl,
          password: config.password,
        } satisfies ActualInitConfig),
      catch: "Failed to initialize Actual API",
    })

    return yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* tryPromise({
          try: () => api.downloadBudget(config.syncId),
          catch: "Failed to download Actual budget",
        })
        return yield* syncDailyVariationTransactions(config)
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

function syncDailyVariationTransactions(config: ActualConfig): Effect.Effect<SyncCounts, Error> {
  return Effect.gen(function* () {
    const endingDate = getTodayIsoDate()
    const transactions = yield* tryPromise({
      try: () => api.getTransactions(config.fintualAccount, config.startingDate, endingDate),
      catch: "Failed to fetch Actual transactions",
    })

    const balanceEntries = yield* loadBalanceEntries(config)
    const payeeId = yield* getPayeeId(config)
    const plan = planReconciliation({
      balanceEntries,
      existingTransactions: transactions,
      payeeId,
    })

    for (const warning of plan.warnings) {
      yield* warn(warning)
    }

    const syncCounts: SyncCounts = {
      created: 0,
      updated: 0,
      deletedDuplicates: 0,
    }

    for (const action of plan.actions) {
      switch (action.type) {
        case "create": {
          yield* tryPromise({
            try: () => api.addTransactions(config.fintualAccount, [action.transaction]),
            catch: "Failed to add Actual transaction",
          })
          syncCounts.created += 1
          break
        }
        case "update": {
          yield* tryPromise({
            try: () => api.updateTransaction(action.id, action.transaction),
            catch: "Failed to update Actual transaction",
          })
          syncCounts.updated += 1
          break
        }
        case "delete": {
          yield* tryPromise({
            try: () => api.deleteTransaction(action.id),
            catch: "Failed to delete duplicate Actual transaction",
          })
          syncCounts.deletedDuplicates += 1
          break
        }
      }
    }

    yield* tryPromise({
      try: () => api.sync(),
      catch: "Failed to sync Actual budget",
    })

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

function loadBalanceEntries(config: ActualConfig): Effect.Effect<BalanceEntry[], Error> {
  return Effect.gen(function* () {
    const parsedFile = yield* trySync({
      // oxlint-disable-next-line typescript/consistent-type-assertions
      try: () => JSON.parse(fs.readFileSync(BALANCE_FILE_PATH, "utf-8")) as unknown,
      catch: "Failed to load Fintual balance file",
    })
    const validation = v.safeParse(balanceFileSchema, parsedFile)

    if (!validation.success) {
      yield* log("Balance file is invalid")
      return []
    }

    const startingTimestamp = Date.parse(config.startingDate)
    return validation.output.balance.filter((entry) => entry.date >= startingTimestamp)
  })
}

function getPayeeId(config: ActualConfig): Effect.Effect<string | undefined, Error> {
  return Effect.gen(function* () {
    const payees = yield* tryPromise({
      try: () => api.getPayees(),
      catch: "Failed to fetch Actual payees",
    })
    const payee = payees.find((candidate) => candidate.name === config.payee)

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

function assertActualServerReachable(config: ActualConfig): Effect.Effect<void, Error> {
  const normalizedBaseUrl = config.serverUrl.endsWith("/")
    ? config.serverUrl.slice(0, -1)
    : config.serverUrl
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
