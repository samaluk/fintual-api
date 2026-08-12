import * as api from "@actual-app/api"
import { Context, Effect, Layer, Predicate, Redacted } from "effect"

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
import type {
  ExistingVariationTransaction,
  VariationTransactionInput,
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
    return yield* Effect.tryPromise({
      try: () => api.getTransactions(accountId, startDate, endDate),
      catch: (cause) =>
        new ActualTransactionsReadFailure({
          cause,
          retryable: isRetryableActualCause(cause),
        }),
    })
  }),

  getPayees: Effect.tryPromise({
    try: () => api.getPayees(),
    catch: (cause) =>
      new ActualPayeesReadFailure({
        cause,
        retryable: isRetryableActualCause(cause),
      }),
  }).pipe(Effect.withSpan("ActualClient.getPayees")),

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
