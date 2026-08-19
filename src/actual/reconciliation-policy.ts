export const VARIATION_NOTES = "Variation"
export const VARIATION_IMPORTED_ID_PREFIX = "fintual-variation:"

export interface ExistingVariationTransaction {
  id: string
  date: string
  notes?: string
  payee?: string | null
  imported_id?: string
}

export interface VariationTransactionInput {
  date: string
  amount: number
  payee?: string
  notes: string
  imported_id: string
  cleared: boolean
}

export interface BalanceEntry {
  date: number
  real_difference: number
}

export type ReconciliationAction =
  | { type: "create"; transaction: VariationTransactionInput }
  | { type: "update"; id: string; transaction: VariationTransactionInput }
  | { type: "delete"; id: string }

export interface ReconciliationPlan {
  actions: ReconciliationAction[]
  warnings: string[]
}

export function planReconciliation(options: {
  balanceEntries: BalanceEntry[]
  existingTransactions: Iterable<ExistingVariationTransaction>
  payeeId?: string
}): ReconciliationPlan {
  const warnings: string[] = []
  const balanceEntries = normalizeBalanceEntries(options.balanceEntries, warnings)
  const variationTransactionsByDate = groupVariationTransactionsByDate(
    options.existingTransactions,
    options.payeeId,
  )

  const actions: ReconciliationAction[] = []
  const processedDates = new Set<string>()

  for (const balanceEntry of balanceEntries) {
    const transaction = createVariationTransaction(balanceEntry, options.payeeId)
    const existingTransactions = variationTransactionsByDate.get(transaction.date) ?? []
    processedDates.add(transaction.date)

    if (existingTransactions.length === 0) {
      actions.push({ type: "create", transaction })
      continue
    }

    const canonicalTransaction = getCanonicalVariationTransaction(
      existingTransactions,
      transaction.date,
    )
    actions.push({ type: "update", id: canonicalTransaction.id, transaction })
    actions.push(...getDeleteActions(existingTransactions, canonicalTransaction.id))
  }

  for (const [date, existingTransactions] of variationTransactionsByDate.entries()) {
    if (processedDates.has(date) || existingTransactions.length < 2) {
      continue
    }

    const canonicalTransaction = getCanonicalVariationTransaction(existingTransactions, date)
    actions.push(...getDeleteActions(existingTransactions, canonicalTransaction.id))
  }

  return { actions, warnings }
}

function normalizeBalanceEntries(
  balanceEntries: BalanceEntry[],
  warnings: string[],
): BalanceEntry[] {
  const entriesByDate = new Map<string, BalanceEntry[]>()

  for (const balanceEntry of balanceEntries) {
    const date = toIsoDate(balanceEntry.date)
    const entries = entriesByDate.get(date) ?? []
    entries.push(balanceEntry)
    entriesByDate.set(date, entries)
  }

  const normalizedEntries: BalanceEntry[] = []

  for (const [date, entries] of entriesByDate.entries()) {
    const latestEntry = entries.sort((left, right) => right.date - left.date)[0]
    normalizedEntries.push(latestEntry)

    if (entries.length > 1) {
      warnings.push(
        `Fintual balance data contains ${entries.length} entries for ${date}. Keeping latest timestamp ${latestEntry.date}.`,
      )
    }
  }

  return normalizedEntries.sort((left, right) => left.date - right.date)
}

function createVariationTransaction(
  balanceEntry: BalanceEntry,
  payeeId: string | undefined,
): VariationTransactionInput {
  const date = toIsoDate(balanceEntry.date)

  return {
    date,
    amount: Math.round(Math.round(balanceEntry.real_difference) * 100),
    payee: payeeId,
    notes: VARIATION_NOTES,
    imported_id: getVariationImportedId(date),
    cleared: true,
  }
}

function getVariationImportedId(date: string): string {
  return `${VARIATION_IMPORTED_ID_PREFIX}${date}`
}

function groupVariationTransactionsByDate(
  transactions: Iterable<ExistingVariationTransaction>,
  payeeId: string | undefined,
): Map<string, ExistingVariationTransaction[]> {
  const transactionsByDate = new Map<string, ExistingVariationTransaction[]>()

  for (const transaction of transactions) {
    if (!isManagedVariationTransaction(transaction, payeeId)) {
      continue
    }

    const dateTransactions = transactionsByDate.get(transaction.date) ?? []
    dateTransactions.push(transaction)
    transactionsByDate.set(transaction.date, dateTransactions)
  }

  return transactionsByDate
}

function isManagedVariationTransaction(
  transaction: ExistingVariationTransaction,
  payeeId: string | undefined,
): boolean {
  return transaction.notes === VARIATION_NOTES && (!payeeId || transaction.payee === payeeId)
}

function getCanonicalVariationTransaction(
  transactions: ExistingVariationTransaction[],
  date: string,
): ExistingVariationTransaction {
  return (
    transactions.find((transaction) => transaction.imported_id === getVariationImportedId(date)) ??
    transactions[0]
  )
}

function getDeleteActions(
  transactions: ExistingVariationTransaction[],
  canonicalTransactionId: string,
): ReconciliationAction[] {
  return transactions
    .filter((transaction) => transaction.id !== canonicalTransactionId)
    .map((transaction) => ({ type: "delete", id: transaction.id }) as const)
}

function toIsoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[0]
}
