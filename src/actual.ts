import * as api from "@actual-app/api"
import * as fs from "node:fs"
import type { TransactionEntity } from "@actual-app/api/@types/loot-core/src/types/models"
import * as v from "valibot"
import type { InitConfig } from "@actual-app/api/@types/loot-core/src/server/main"
import "./env"

const SERVER_URL = process.env.ACTUAL_SERVER_URL ?? ""
const PASSWORD = process.env.ACTUAL_PASSWORD ?? ""
const SYNC_ID = process.env.ACTUAL_SYNC_ID ?? ""
const BUDGET_ID = process.env.ACTUAL_BUDGET_ID ?? ""
const FINTUAL_ACCOUNT = process.env.ACTUAL_FINTUAL_ACCOUNT ?? ""
const STARTING_DATE = process.env.STARTING_DATE ?? "2024-03-01"
const PAYEE = process.env.ACTUAL_PAYEE ?? "Fintual"

if (!SERVER_URL || !PASSWORD || !SYNC_ID || !BUDGET_ID || !FINTUAL_ACCOUNT || !STARTING_DATE || !PAYEE) {
	console.error("Missing environment variables")
	process.exit(1)
}

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
async function dailyVariation() {
	const transactions = (await api.getTransactions(FINTUAL_ACCOUNT, undefined, undefined)) as TransactionEntity[]
	console.log("Transactions count:", transactions.length)

	let total = 0
	for (const element of transactions) {
		total += element.amount
	}
	console.log("Total:", api.utils.integerToAmount(total))

	// open balance.json file
	const balanceFile = fs.readFileSync("./tmp/fintual-data/balance-2.json", "utf-8")
	const balance = JSON.parse(balanceFile)
	// validate balance file
	const balanceValidation = v.safeParse(balanceFileSchema, balance)
	if (!balanceValidation.success) {
		console.error("Balance file is invalid:", balanceValidation.issues)
		return
	}

	// for each balance entry, create a transaction
	const balanceData = balanceValidation.output.balance
	// filter balance data to only include entries after STARTING_DATE
	const filteredBalanceData = balanceData.filter((b) => b.date >= Date.parse(STARTING_DATE))

	const payeeId = await getPayeeId()
	for (const b of filteredBalanceData) {
		const transaction: Omit<TransactionEntity, "id"> = {
			account: FINTUAL_ACCOUNT,
			date: new Date(b.date).toISOString().split("T")[0],
			amount: Math.round(Math.round(b.real_difference) * 100),
			payee: payeeId,
			notes: "Variation",
			imported_id: b.date.toString(),
			cleared: true,
			// reconciled: true,
			// tombstone: false,
		}

		const existingTransaction = transactions.find((t) => t.imported_id === transaction.imported_id)
		if (existingTransaction) {
			console.log(
				`Transaction with imported_id ${transaction.imported_id} already exists, skipping creation. Amount: ${existingTransaction.amount}. Type: ${typeof existingTransaction.amount}. Difference: ${Math.round(b.real_difference)}`,
			)
			await api.updateTransaction(existingTransaction.id, {
				account: FINTUAL_ACCOUNT,
				date: new Date(b.date).toISOString().split("T")[0],
				amount: Math.round(Math.round(b.real_difference) * 100),
				payee: payeeId,
				notes: "Variation",
				imported_id: b.date.toString(),
				cleared: true,
				// reconciled: true,
				// tombstone: false,
			})
		} else {
			console.log(`Creating transaction with imported_id ${transaction.imported_id}`)
			await api.addTransactions(FINTUAL_ACCOUNT, [transaction])
		}
	}
}

async function baseVariation() {
	// sum up all real differences from the balance.json file
	const balanceFile = fs.readFileSync("./tmp/fintual-data/balance-2.json", "utf-8")
	const balance = JSON.parse(balanceFile)
	// validate balance file
	const balanceValidation = v.safeParse(balanceFileSchema, balance)
	if (!balanceValidation.success) {
		console.error("Balance file is invalid:", balanceValidation.issues)
		return
	}
	const balanceData = balanceValidation.output.balance

	// sum up all real differences before march 2024
	const filteredBalanceData = balanceData.filter((b) => b.date < Date.parse(STARTING_DATE))

	let sum = 0
	for (const b of filteredBalanceData) {
		sum += b.real_difference
	}

	const dateInWords = new Date(Date.parse(STARTING_DATE)).toLocaleDateString("es-CL")
	console.log(`Sum of real differences before ${dateInWords}:`, Math.round(sum * 100))

	// create a transatcion for the sum
	const payeeId = await getPayeeId()
	const transaction: Omit<TransactionEntity, "id"> = {
		account: FINTUAL_ACCOUNT,
		date: new Date(Date.parse(STARTING_DATE)).toISOString().split("T")[0],
		amount: Math.round(sum / 100),
		payee: payeeId,
		notes: "Base variation",
		imported_id: `${Date.parse(STARTING_DATE).toString()}_base`,
		cleared: true,
		// reconciled: true,
		// tombstone: false,
	}
	const existingTransactions = await api.getTransactions(FINTUAL_ACCOUNT, undefined, undefined)
	// check if the transaction already exists
	const existingTransaction = existingTransactions.find((t) => t.imported_id === transaction.imported_id)

	if (existingTransaction) {
		console.log(
			`Transaction with imported_id ${transaction.imported_id} already exists, skipping creation. Amount: ${existingTransaction.amount}. Type: ${typeof existingTransaction.amount}, Difference: ${Math.round(sum)}`,
		)
		await api.updateTransaction(existingTransaction.id, {
			account: FINTUAL_ACCOUNT,
			date: new Date(Date.parse(STARTING_DATE)).toISOString().split("T")[0],
			amount: Math.round(sum) * 100,
			payee: payeeId,
			notes: "Base variation",
			imported_id: `${Date.parse(STARTING_DATE).toString()}_base`,
			cleared: true,
			// reconciled: true,
			// tombstone: false,
		})
	} else {
		console.log(`Creating transaction with imported_id ${transaction.imported_id}`)
		await api.addTransactions(FINTUAL_ACCOUNT, [transaction])
	}
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
	await dailyVariation()
	// await baseVariation()
	await api.shutdown()
}
