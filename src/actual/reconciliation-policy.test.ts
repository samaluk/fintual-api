import { expect, test } from "vitest"

import {
  VARIATION_IMPORTED_ID_PREFIX,
  VARIATION_NOTES,
  planReconciliation,
  type BalanceEntry,
  type ExistingVariationTransaction,
} from "./reconciliation-policy.ts"

function balanceEntry(date: string, realDifference: number, timestampOffsetMs = 0): BalanceEntry {
  return {
    date: Date.parse(`${date}T00:00:00Z`) + timestampOffsetMs,
    real_difference: realDifference,
  }
}

function existingTransaction(
  id: string,
  date: string,
  options: { notes?: string; payee?: string; importedId?: string } = {},
): ExistingVariationTransaction {
  return {
    id,
    date,
    notes: options.notes ?? VARIATION_NOTES,
    payee: options.payee,
    imported_id: options.importedId,
  }
}

function variationTransaction(date: string, amount: number, payeeId?: string) {
  return {
    date,
    amount,
    payee: payeeId,
    notes: VARIATION_NOTES,
    imported_id: `${VARIATION_IMPORTED_ID_PREFIX}${date}`,
    cleared: true,
  }
}

const create = (transaction: ReturnType<typeof variationTransaction>) =>
  ({ type: "create", transaction }) as const
const update = (id: string, transaction: ReturnType<typeof variationTransaction>) =>
  ({ type: "update", id, transaction }) as const
const deleteTransaction = (id: string) => ({ type: "delete", id }) as const

test.each([
  {
    name: "creates a transaction when no managed transaction exists for the date",
    balanceEntries: [balanceEntry("2026-01-05", 12.49)],
    existingTransactions: [],
    payeeId: "payee-1",
    expectedActions: [create(variationTransaction("2026-01-05", 1200, "payee-1"))],
  },
  {
    name: "updates the canonical transaction and deletes legacy duplicates",
    balanceEntries: [balanceEntry("2026-01-05", -4.75)],
    existingTransactions: [
      existingTransaction("legacy-1", "2026-01-05", {
        importedId: String(Date.parse("2026-01-05T00:00:00Z")),
      }),
      existingTransaction("canon", "2026-01-05", {
        importedId: `${VARIATION_IMPORTED_ID_PREFIX}2026-01-05`,
      }),
    ],
    expectedActions: [
      update("canon", variationTransaction("2026-01-05", -500)),
      deleteTransaction("legacy-1"),
    ],
  },
  {
    name: "updates the first legacy transaction when no canonical id exists",
    balanceEntries: [balanceEntry("2026-01-05", 3)],
    existingTransactions: [
      existingTransaction("legacy-1", "2026-01-05", {
        importedId: String(Date.parse("2026-01-05T00:00:00Z")),
      }),
      existingTransaction("legacy-2", "2026-01-05", {
        importedId: String(Date.parse("2026-01-05T00:00:00Z") + 1000),
      }),
    ],
    expectedActions: [
      update("legacy-1", variationTransaction("2026-01-05", 300)),
      deleteTransaction("legacy-2"),
    ],
  },
  {
    name: "manages every variation transaction when no payee is configured",
    balanceEntries: [balanceEntry("2026-01-05", 6)],
    existingTransactions: [
      existingTransaction("foreign-payee", "2026-01-05", { payee: "someone-else" }),
    ],
    expectedActions: [update("foreign-payee", variationTransaction("2026-01-05", 600))],
  },
  {
    name: "ignores transactions with different notes or payee and creates a new one",
    balanceEntries: [balanceEntry("2026-01-05", 8.49)],
    existingTransactions: [
      existingTransaction("other-1", "2026-01-05", { notes: "Salary" }),
      existingTransaction("other-2", "2026-01-05", { payee: "someone-else" }),
      existingTransaction("other-3", "2026-01-05", { notes: "Salary", payee: "someone-else" }),
    ],
    payeeId: "payee-1",
    expectedActions: [create(variationTransaction("2026-01-05", 800, "payee-1"))],
  },
  {
    name: "reconciles multiple dates in balance entry order",
    balanceEntries: [balanceEntry("2026-01-06", 5), balanceEntry("2026-01-05", 10)],
    existingTransactions: [
      existingTransaction("jan-5", "2026-01-05", {
        importedId: `${VARIATION_IMPORTED_ID_PREFIX}2026-01-05`,
      }),
      existingTransaction("jan-6", "2026-01-06", {
        importedId: `${VARIATION_IMPORTED_ID_PREFIX}2026-01-06`,
      }),
      existingTransaction("jan-6-dup", "2026-01-06", {
        importedId: `${VARIATION_IMPORTED_ID_PREFIX}2026-01-06`,
      }),
    ],
    expectedActions: [
      update("jan-5", variationTransaction("2026-01-05", 1000)),
      update("jan-6", variationTransaction("2026-01-06", 500)),
      deleteTransaction("jan-6-dup"),
    ],
  },
  {
    name: "deletes duplicates for dates with no balance entry",
    balanceEntries: [balanceEntry("2026-01-05", 1)],
    existingTransactions: [
      existingTransaction("jan-5", "2026-01-05", {
        importedId: `${VARIATION_IMPORTED_ID_PREFIX}2026-01-05`,
      }),
      existingTransaction("orphan-1", "2026-01-07", {
        importedId: String(Date.parse("2026-01-07T00:00:00Z")),
      }),
      existingTransaction("orphan-2", "2026-01-07", {
        importedId: `${VARIATION_IMPORTED_ID_PREFIX}2026-01-07`,
      }),
    ],
    expectedActions: [
      update("jan-5", variationTransaction("2026-01-05", 100)),
      deleteTransaction("orphan-1"),
    ],
  },
  {
    name: "leaves a single orphaned transaction untouched",
    balanceEntries: [],
    existingTransactions: [
      existingTransaction("orphan-1", "2026-01-07", {
        importedId: `${VARIATION_IMPORTED_ID_PREFIX}2026-01-07`,
      }),
    ],
    expectedActions: [],
  },
])("$name", ({ balanceEntries, existingTransactions, payeeId, expectedActions }) => {
  const plan = planReconciliation({ balanceEntries, existingTransactions, payeeId })

  expect(plan.actions).toEqual(expectedActions)
})

test("keeps the latest timestamp when the balance file has duplicate dates", () => {
  const plan = planReconciliation({
    balanceEntries: [
      balanceEntry("2026-01-05", 10, 0),
      balanceEntry("2026-01-05", 11.49, 3600_000),
    ],
    existingTransactions: [],
  })

  expect(plan.actions).toEqual([create(variationTransaction("2026-01-05", 1100))])
  expect(plan.warnings).toEqual([
    "Fintual balance data contains 2 entries for 2026-01-05. Keeping latest timestamp " +
      `${Date.parse("2026-01-05T00:00:00Z") + 3600_000}.`,
  ])
})
