import * as api from "@actual-app/api"
import { Context, DateTime, Effect, Layer, Predicate, Redacted, Schema } from "effect"

import type { ActualConfig } from "../env.ts"
import type { PerformanceSnapshot } from "../performance-snapshot.ts"
import {
  ActualInitializationFailure,
  ActualOperationFailure,
  type ActualError,
} from "./actual-error.ts"
import {
  VARIATION_IMPORTED_ID_PREFIX,
  planReconciliation,
  type ExistingVariationTransaction,
} from "./reconciliation-policy.ts"

const ACTUAL_DATA_DIR = "./tmp/actual-data"

type ActualInitConfig = Parameters<typeof api.init>[0]

interface ActualPayee {
  readonly id: string
  readonly name: string
}

export interface SyncCounts {
  readonly created: number
  readonly updated: number
  readonly deletedDuplicates: number
}

export interface ActualReconcileOptions {
  readonly startingDate: string
  readonly startingTimestamp: number
  readonly accountId: string
  readonly payeeName: string
}

export interface ActualClient {
  readonly reconcile: (
    snapshot: PerformanceSnapshot,
    options: ActualReconcileOptions,
  ) => Effect.Effect<SyncCounts, ActualError>
  readonly shutdown: Effect.Effect<void, ActualOperationFailure>
}

export class ActualClientFactory extends Context.Service<
  ActualClientFactory,
  {
    readonly acquire: (
      config: ActualConfig,
    ) => Effect.Effect<ActualClient, ActualInitializationFailure>
  }
>()("ActualClientFactory") {
  static readonly live = Layer.succeed(
    ActualClientFactory,
    ActualClientFactory.of({
      acquire: Effect.fn("ActualClientFactory.acquire")(function* (config: ActualConfig) {
        yield* Effect.tryPromise({
          try: () =>
            api.init({
              dataDir: ACTUAL_DATA_DIR,
              serverURL: config.serverUrl,
              password: Redacted.value(config.password),
              verbose: false,
            } satisfies ActualInitConfig),
          catch: (cause) =>
            new ActualInitializationFailure({
              cause,
              retryable: isRetryableActualCause(cause),
            }),
        })

        return makeActualClient(config.syncId)
      }),
    }),
  )
}

function makeActualClient(syncId: string): ActualClient {
  return {
    reconcile: Effect.fn("ActualClient.reconcile")(function* (
      snapshot: PerformanceSnapshot,
      options: ActualReconcileOptions,
    ): Effect.fn.Return<SyncCounts, ActualError> {
      yield* Effect.tryPromise({
        try: () => api.downloadBudget(syncId),
        catch: (cause) =>
          new ActualOperationFailure({
            operation: "download_budget",
            cause,
            retryable: isRetryableActualCause(cause),
          }),
      })

      const endingDate = DateTime.formatIsoDateUtc(yield* DateTime.now)
      const rows = yield* Effect.tryPromise({
        try: () => api.getTransactions(options.accountId, options.startingDate, endingDate),
        catch: (cause) =>
          new ActualOperationFailure({
            operation: "get_transactions",
            cause,
            retryable: isRetryableActualCause(cause),
          }),
      })
      const transactions = yield* decodeTransactions(rows)

      const payees = yield* Effect.tryPromise({
        try: () => api.getPayees(),
        catch: (cause) =>
          new ActualOperationFailure({
            operation: "get_payees",
            cause,
            retryable: isRetryableActualCause(cause),
          }),
      }).pipe(Effect.andThen(decodePayees))

      const matchedPayee = payees.find((candidate) => candidate.name === options.payeeName)
      if (!matchedPayee) {
        yield* Effect.logInfo("Configured payee not found")
      }
      const payeeId = matchedPayee?.id

      const balanceEntries = snapshot.balance.filter(
        (entry) => entry.date >= options.startingTimestamp,
      )
      const plan = planReconciliation({
        balanceEntries,
        existingTransactions: transactions,
        payeeId,
      })

      for (const warning of plan.warnings) {
        yield* Effect.logWarning(warning)
      }

      const syncCounts = {
        created: 0,
        updated: 0,
        deletedDuplicates: 0,
      }

      for (const action of plan.actions) {
        switch (action.type) {
          case "create": {
            yield* Effect.tryPromise({
              try: () => api.addTransactions(options.accountId, [action.transaction]),
              catch: (cause) =>
                new ActualOperationFailure({
                  operation: "create_transaction",
                  cause,
                  retryable: isRetryableActualCause(cause),
                }),
            })
            syncCounts.created += 1
            break
          }
          case "update": {
            yield* Effect.tryPromise({
              try: () => api.updateTransaction(action.id, action.transaction),
              catch: (cause) =>
                new ActualOperationFailure({
                  operation: "update_transaction",
                  cause,
                  retryable: isRetryableActualCause(cause),
                }),
            })
            syncCounts.updated += 1
            break
          }
          case "delete": {
            yield* Effect.tryPromise({
              try: () => api.deleteTransaction(action.id),
              catch: (cause) =>
                new ActualOperationFailure({
                  operation: "delete_transaction",
                  cause,
                  retryable: isRetryableActualCause(cause),
                }),
            })
            syncCounts.deletedDuplicates += 1
            break
          }
        }
      }

      yield* Effect.tryPromise({
        try: () => api.sync(),
        catch: (cause) =>
          new ActualOperationFailure({
            operation: "sync",
            cause,
            retryable: isRetryableActualCause(cause),
          }),
      })

      return syncCounts
    }),

    shutdown: Effect.tryPromise({
      try: () => api.shutdown(),
      catch: (cause) =>
        new ActualOperationFailure({
          operation: "shutdown",
          cause,
          retryable: false,
        }),
    }).pipe(Effect.withSpan("ActualClient.shutdown")),
  }
}

function isRetryableActualCause(cause: unknown): boolean {
  if (!Predicate.isObject(cause)) {
    return false
  }

  return cause.code === "network-failure" || cause.reason === "network-failure"
}

const sdkTransactionRowSchema = Schema.Struct({
  id: Schema.String,
  date: Schema.optional(Schema.NullOr(Schema.String)),
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  payee: Schema.optional(Schema.NullOr(Schema.String)),
  imported_id: Schema.optional(Schema.NullOr(Schema.String)),
})

const sdkPayeeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

const decodeTransactions = Effect.fn("ActualClient.decodeTransactions")(function* (
  rows: unknown,
): Effect.fn.Return<ReadonlyArray<ExistingVariationTransaction>, ActualOperationFailure> {
  return yield* Schema.decodeUnknownEffect(Schema.Array(sdkTransactionRowSchema))(rows).pipe(
    Effect.map((rows) =>
      rows.flatMap((row) => {
        const transaction = toExistingVariationTransaction(row)
        return transaction ? [transaction] : []
      }),
    ),
    Effect.mapError(
      (cause) =>
        new ActualOperationFailure({
          operation: "get_transactions",
          cause,
          retryable: false,
        }),
    ),
  )
})

type SdkPayeeRow = Awaited<ReturnType<typeof api.getPayees>>[number]

const decodePayees = Effect.fn("ActualClient.decodePayees")(function* (
  payees: ReadonlyArray<SdkPayeeRow>,
): Effect.fn.Return<ReadonlyArray<ActualPayee>, ActualOperationFailure> {
  return yield* Schema.decodeEffect(Schema.Array(sdkPayeeSchema))(payees).pipe(
    Effect.mapError(
      (cause) =>
        new ActualOperationFailure({
          operation: "get_payees",
          cause,
          retryable: false,
        }),
    ),
  )
})

function toExistingVariationTransaction(
  row: Schema.Schema.Type<typeof sdkTransactionRowSchema>,
): ExistingVariationTransaction | null {
  const date = getVariationTransactionDate(row)
  if (!date) {
    return null
  }

  return {
    id: row.id,
    date,
    notes: row.notes ?? undefined,
    payee: row.payee,
    imported_id: row.imported_id ?? undefined,
  }
}

function getVariationTransactionDate(
  row: Schema.Schema.Type<typeof sdkTransactionRowSchema>,
): string | null {
  if (row.imported_id?.startsWith(VARIATION_IMPORTED_ID_PREFIX)) {
    const date = row.imported_id.slice(VARIATION_IMPORTED_ID_PREFIX.length)
    if (isIsoDate(date)) {
      return date
    }
  }

  if (row.imported_id && isNumericTimestamp(row.imported_id)) {
    return toIsoDate(Number(row.imported_id))
  }

  if (row.date && isIsoDate(row.date)) {
    return row.date
  }

  return null
}

function toIsoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[0]
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isNumericTimestamp(value: string): boolean {
  return /^\d+$/.test(value)
}
