import * as fs from "node:fs"
import * as api from "@actual-app/api"
import type { InitConfig } from "@actual-app/api/@types/loot-core/src/server/main"
import type { TransactionEntity } from "@actual-app/api/@types/loot-core/src/types/models"
import * as v from "valibot"
import { getEnv } from "./env"
import { getErrorMessage } from "./log"

const SERVER_URL = getEnv("ACTUAL_SERVER_URL")
const PASSWORD = getEnv("ACTUAL_PASSWORD")
const SYNC_ID = getEnv("ACTUAL_SYNC_ID")
const FINTUAL_ACCOUNT = getEnv("ACTUAL_FINTUAL_ACCOUNT")
const STARTING_DATE = getEnv("ACTUAL_STARTING_DATE", getEnv("STARTING_DATE", "2024-03-01"))
const PAYEE = getEnv("ACTUAL_PAYEE", "Fintual")

const ACTUAL_DATA_DIR = "./tmp/actual-data"
const BALANCE_FILE_PATH = "./tmp/fintual-data/balance-2.json"
const MAX_SYNC_ATTEMPTS = 3
const RETRY_DELAY_MS = 5000

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

if (!SERVER_URL || !PASSWORD || !SYNC_ID || !FINTUAL_ACCOUNT || !STARTING_DATE || !PAYEE) {
	console.error("Missing environment variables")
	process.exit(1)
}

type BalanceEntry = v.InferOutput<typeof balanceFileSchema>["balance"][number]

interface SyncCounts {
	created: number
	updated: number
}

export async function main(): Promise<void> {
	for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
		try {
			const syncCounts = await runActualSyncAttempt()
			console.log(`Actual sync finished. Created ${syncCounts.created} transactions and updated ${syncCounts.updated}.`)
			return
		} catch (error) {
			const errorMessage = getErrorMessage(error)
			const shouldRetry = isRetryableActualError(error) && attempt < MAX_SYNC_ATTEMPTS

			if (!shouldRetry) {
				throw error
			}

			console.warn(
				`Actual sync attempt ${attempt} failed with a retryable error: ${errorMessage}. Retrying in ${Math.round(RETRY_DELAY_MS / 1000)}s.`,
			)
			await sleep(RETRY_DELAY_MS)
		}
	}
}

async function runActualSyncAttempt(): Promise<SyncCounts> {
	resetDataDirectory()

	await api.init({
		dataDir: ACTUAL_DATA_DIR,
		serverURL: SERVER_URL,
		password: PASSWORD,
	} satisfies InitConfig)

	try {
		await api.downloadBudget(SYNC_ID)
		return await syncDailyVariationTransactions()
	} finally {
		await api.shutdown().catch(() => undefined)
	}
}

async function syncDailyVariationTransactions(): Promise<SyncCounts> {
	const endingDate = getTodayIsoDate()
	const transactions = (await api.getTransactions(FINTUAL_ACCOUNT, STARTING_DATE, endingDate)) as TransactionEntity[]

	const balanceEntries = loadBalanceEntries()
	const payeeId = await getPayeeId()
	const syncCounts: SyncCounts = {
		created: 0,
		updated: 0,
	}

	for (const balanceEntry of balanceEntries) {
		const transaction = createVariationTransaction(balanceEntry, payeeId)
		const existingTransaction = transactions.find((candidate) => candidate.imported_id === transaction.imported_id)

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
): Omit<TransactionEntity, "id"> {
	return {
		account: FINTUAL_ACCOUNT,
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
		return error.message.includes("network-failure")
	}

	if (!isRecord(error)) {
		return false
	}

	return error.type === "PostError" && error.reason === "network-failure"
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
