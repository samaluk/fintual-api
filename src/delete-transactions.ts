import * as api from "@actual-app/api"
import * as fs from "node:fs"
import type { TransactionEntity } from "@actual-app/api/@types/loot-core/src/types/models"
import type { InitConfig } from "@actual-app/api/@types/loot-core/src/server/main"
import "./env"

const SERVER_URL = process.env.ACTUAL_SERVER_URL ?? ""
const PASSWORD = process.env.ACTUAL_PASSWORD ?? ""
const SYNC_ID = process.env.ACTUAL_SYNC_ID ?? ""
const BUDGET_ID = process.env.ACTUAL_BUDGET_ID ?? ""
const FINTUAL_ACCOUNT = process.env.ACTUAL_FINTUAL_ACCOUNT ?? ""
const STARTING_DATE = process.env.STARTING_DATE ?? "2024-03-01"
const PAYEE = process.env.ACTUAL_PAYEE ?? "Fintual"

if (
	!SERVER_URL ||
	!PASSWORD ||
	!SYNC_ID ||
	!BUDGET_ID ||
	!FINTUAL_ACCOUNT ||
	!STARTING_DATE ||
	!PAYEE
) {
	console.error("Missing environment variables")
	process.exit(1)
}

async function getPayeeId() {
	const payees = await api.getPayees()
	const payee = payees.find((p) => p.name === PAYEE)
	if (!payee) {
		console.error(`Payee "${PAYEE}" not found`)
		return
	}
	return payee.id
}

async function deleteVariationTransactions() {
	const transactions = (await api.getTransactions(
		FINTUAL_ACCOUNT,
		undefined,
		undefined,
	)) as TransactionEntity[]
	const payeeId = await getPayeeId()
	const deleted_transactions: TransactionEntity[] = []
	for (const transaction of transactions) {
		if (
			(transaction.notes === "Variation" ||
				transaction.notes === "Base variation") &&
			transaction.account === FINTUAL_ACCOUNT &&
			transaction.payee === payeeId
		) {
			deleted_transactions.push(transaction)
			await api.deleteTransaction(transaction.id)
		}
	}
	console.log("Deleted transactions count:", deleted_transactions.length)
}

export async function main() {
	if (!fs.existsSync("./tmp/actual-data")) {
		fs.mkdirSync("./tmp/actual-data", { recursive: true })
	}
	await api.init({
		dataDir: "./tmp/actual-data",
		serverURL: SERVER_URL,
		password: PASSWORD,
	} satisfies InitConfig)
	await api.downloadBudget(SYNC_ID)
	await deleteVariationTransactions()
	await api.shutdown()
}

main()
