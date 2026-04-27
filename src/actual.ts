import * as fs from "node:fs"
import * as api from "@actual-app/api"
import * as v from "valibot"
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

export async function main(): Promise<void> {
  assertActualEnvConfigured()

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    try {
      const syncCounts = await runActualSyncAttempt()
      console.log(
        `Actual sync finished. Created ${syncCounts.created} transactions and updated ${syncCounts.updated}.`,
      )
      return
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      const shouldRetry = isRetryableActualError(error) && attempt < MAX_SYNC_ATTEMPTS

      if (!shouldRetry) {
        throw error
      }

      const retryDelayMs = getRetryDelayMs(attempt)
      console.warn(
        `Actual sync attempt ${attempt} failed with a retryable error: ${errorMessage}. Retrying in ${Math.round(retryDelayMs / 1000)}s.`,
      )
      await sleep(retryDelayMs)
    }
  }
}

function assertActualEnvConfigured(): void {
  if (SERVER_URL && PASSWORD && SYNC_ID && FINTUAL_ACCOUNT && STARTING_DATE && PAYEE) {
    return
  }

  throw new Error("Missing Actual configuration environment variables")
}

async function runActualSyncAttempt(): Promise<SyncCounts> {
  resetDataDirectory()
  await assertActualServerReachable()

  await api.init({
    dataDir: ACTUAL_DATA_DIR,
    serverURL: SERVER_URL,
    password: PASSWORD,
  } satisfies ActualInitConfig)

  try {
    await api.downloadBudget(SYNC_ID)
    return await syncDailyVariationTransactions()
  } finally {
    await api.shutdown().catch(() => undefined)
  }
}

async function syncDailyVariationTransactions(): Promise<SyncCounts> {
  const endingDate = getTodayIsoDate()
  const transactions = await api.getTransactions(FINTUAL_ACCOUNT, STARTING_DATE, endingDate)

  const balanceEntries = loadBalanceEntries()
  const payeeId = await getPayeeId()
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
      await api.addTransactions(FINTUAL_ACCOUNT, [transaction])
      syncCounts.created += 1
      continue
    }

    await api.updateTransaction(existingTransaction.id, transaction)
    syncCounts.updated += 1
  }

  return syncCounts
}

function resetDataDirectory(): void {
  fs.rmSync(ACTUAL_DATA_DIR, { recursive: true, force: true })
  fs.mkdirSync(ACTUAL_DATA_DIR, { recursive: true })
}

function loadBalanceEntries(): BalanceEntry[] {
  const balanceFile = fs.readFileSync(BALANCE_FILE_PATH, "utf-8")
  const parsedFile = JSON.parse(balanceFile)
  const validation = v.safeParse(balanceFileSchema, parsedFile)

  if (!validation.success) {
    console.error("Balance file is invalid")
    return []
  }

  const startingTimestamp = Date.parse(STARTING_DATE)
  return validation.output.balance.filter((entry) => entry.date >= startingTimestamp)
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

async function getPayeeId(): Promise<string | undefined> {
  const payees = await api.getPayees()
  const payee = payees.find((candidate) => candidate.name === PAYEE)

  if (!payee) {
    console.error("Configured payee not found")
    return undefined
  }

  return payee.id
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

async function assertActualServerReachable(): Promise<void> {
  const normalizedBaseUrl = SERVER_URL.endsWith("/") ? SERVER_URL.slice(0, -1) : SERVER_URL
  const healthUrl = `${normalizedBaseUrl}/health`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (response.ok) {
      return
    }

    throw new Error(`health endpoint returned HTTP ${response.status}`)
  } catch (error) {
    const details = getErrorMessage(error)
    throw new Error(`Actual server is unreachable at ${healthUrl}: ${details}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
