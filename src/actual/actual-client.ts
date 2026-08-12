import * as api from "@actual-app/api"
import { Context, Effect, Layer, Predicate, Redacted, Schema } from "effect"

import type { ActualConfig } from "../env.ts"
import {
  ActualBudgetDownloadFailure,
  ActualDuplicateDeletionFailure,
  ActualInitializationFailure,
  ActualPayeesReadFailure,
  ActualShutdownFailure,
  ActualSyncFailure,
  ActualTransactionCreationFailure,
  ActualTransactionUpdateFailure,
  ActualTransactionsReadFailure,
} from "./actual-error.ts"
import {
  VARIATION_IMPORTED_ID_PREFIX,
  type ExistingVariationTransaction,
  type VariationTransactionInput,
} from "./variation-transaction.ts"

const ACTUAL_DATA_DIR = "./tmp/actual-data"

type ActualInitConfig = Parameters<typeof api.init>[0]

export interface ActualPayee {
  readonly id: string
  readonly name: string
}

export interface ActualClient {
  readonly downloadBudget: (syncId: string) => Effect.Effect<void, ActualBudgetDownloadFailure>
  readonly getTransactions: (
    accountId: string,
    startDate: string,
    endDate: string,
  ) => Effect.Effect<ReadonlyArray<ExistingVariationTransaction>, ActualTransactionsReadFailure>
  readonly getPayees: Effect.Effect<ReadonlyArray<ActualPayee>, ActualPayeesReadFailure>
  readonly createTransaction: (
    accountId: string,
    transaction: VariationTransactionInput,
  ) => Effect.Effect<void, ActualTransactionCreationFailure>
  readonly updateTransaction: (
    id: string,
    transaction: VariationTransactionInput,
  ) => Effect.Effect<void, ActualTransactionUpdateFailure>
  readonly deleteTransaction: (id: string) => Effect.Effect<void, ActualDuplicateDeletionFailure>
  readonly sync: Effect.Effect<void, ActualSyncFailure>
  readonly shutdown: Effect.Effect<void, ActualShutdownFailure>
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

        return ActualClientLive
      }),
    }),
  )
}

const ActualClientLive: ActualClient = {
  downloadBudget: Effect.fn("ActualClient.downloadBudget")(function* (syncId: string) {
    yield* Effect.tryPromise({
      try: () => api.downloadBudget(syncId),
      catch: (cause) =>
        new ActualBudgetDownloadFailure({
          cause,
          retryable: isRetryableActualCause(cause),
        }),
    })
  }),

  getTransactions: Effect.fn("ActualClient.getTransactions")(function* (
    accountId: string,
    startDate: string,
    endDate: string,
  ) {
    const rows = yield* Effect.tryPromise({
      try: () => api.getTransactions(accountId, startDate, endDate),
      catch: (cause) =>
        new ActualTransactionsReadFailure({
          cause,
          retryable: isRetryableActualCause(cause),
        }),
    })

    return yield* decodeTransactions(rows)
  }),

  getPayees: Effect.tryPromise({
    try: () => api.getPayees(),
    catch: (cause) =>
      new ActualPayeesReadFailure({
        cause,
        retryable: isRetryableActualCause(cause),
      }),
  }).pipe(
    Effect.andThen((payees) => decodePayees(payees)),
    Effect.withSpan("ActualClient.getPayees"),
  ),

  createTransaction: Effect.fn("ActualClient.createTransaction")(function* (
    accountId: string,
    transaction: VariationTransactionInput,
  ) {
    yield* Effect.tryPromise({
      try: () => api.addTransactions(accountId, [transaction]),
      catch: (cause) =>
        new ActualTransactionCreationFailure({
          cause,
          retryable: isRetryableActualCause(cause),
        }),
    })
  }),

  updateTransaction: Effect.fn("ActualClient.updateTransaction")(function* (
    id: string,
    transaction: VariationTransactionInput,
  ) {
    yield* Effect.tryPromise({
      try: () => api.updateTransaction(id, transaction),
      catch: (cause) =>
        new ActualTransactionUpdateFailure({
          cause,
          retryable: isRetryableActualCause(cause),
        }),
    })
  }),

  deleteTransaction: Effect.fn("ActualClient.deleteTransaction")(function* (id: string) {
    yield* Effect.tryPromise({
      try: () => api.deleteTransaction(id),
      catch: (cause) =>
        new ActualDuplicateDeletionFailure({
          cause,
          retryable: isRetryableActualCause(cause),
        }),
    })
  }),

  sync: Effect.tryPromise({
    try: () => api.sync(),
    catch: (cause) =>
      new ActualSyncFailure({
        cause,
        retryable: isRetryableActualCause(cause),
      }),
  }).pipe(Effect.withSpan("ActualClient.sync")),

  shutdown: Effect.tryPromise({
    try: () => api.shutdown(),
    catch: (cause) => new ActualShutdownFailure({ cause, retryable: false }),
  }).pipe(Effect.withSpan("ActualClient.shutdown")),
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
): Effect.fn.Return<ReadonlyArray<ExistingVariationTransaction>, ActualTransactionsReadFailure> {
  return yield* Schema.decodeUnknownEffect(Schema.Array(sdkTransactionRowSchema))(rows).pipe(
    Effect.map((rows) =>
      rows.flatMap((row) => {
        const transaction = toExistingVariationTransaction(row)
        return transaction ? [transaction] : []
      }),
    ),
    Effect.mapError((cause) => new ActualTransactionsReadFailure({ cause, retryable: false })),
  )
})

type SdkPayeeRow = Awaited<ReturnType<typeof api.getPayees>>[number]

const decodePayees = Effect.fn("ActualClient.decodePayees")(function* (
  payees: ReadonlyArray<SdkPayeeRow>,
): Effect.fn.Return<ReadonlyArray<ActualPayee>, ActualPayeesReadFailure> {
  return yield* Schema.decodeEffect(Schema.Array(sdkPayeeSchema))(payees).pipe(
    Effect.mapError((cause) => new ActualPayeesReadFailure({ cause, retryable: false })),
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
