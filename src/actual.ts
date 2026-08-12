import { Context, DateTime, Duration, Effect, Layer, Option, Schedule } from "effect"

import { ActualClientFactory, type ActualClient } from "./actual/actual-client.ts"
import { ActualInvalidStartingDate } from "./actual/actual-error.ts"
import type { ActualError, ActualPayeesReadFailure } from "./actual/actual-error.ts"
import { ActualFileSystem } from "./actual/actual-file-system.ts"
import { ActualHealthCheck } from "./actual/actual-health-check.ts"
import { planReconciliation } from "./actual/reconciliation-policy.ts"
import { ActualRetryPolicy } from "./actual/retry-policy.ts"
import type { ActualConfig } from "./env.ts"
import { getErrorMessage } from "./log.ts"
import type { PerformanceSnapshot } from "./performance-snapshot.ts"

export type { ActualError } from "./actual/actual-error.ts"

interface SyncCounts {
  readonly created: number
  readonly updated: number
  readonly deletedDuplicates: number
}

export class ActualConfigService extends Context.Service<ActualConfigService, ActualConfig>()(
  "ActualConfig",
) {}

export class ActualSynchronization extends Context.Service<
  ActualSynchronization,
  {
    readonly synchronize: (snapshot: PerformanceSnapshot) => Effect.Effect<void, ActualError>
  }
>()("ActualSynchronization") {
  static readonly layer = Layer.effect(
    ActualSynchronization,
    Effect.gen(function* () {
      const config = yield* ActualConfigService
      const clientFactory = yield* ActualClientFactory
      const fileSystem = yield* ActualFileSystem
      const healthCheck = yield* ActualHealthCheck
      const retryPolicy = yield* ActualRetryPolicy

      const synchronize = Effect.fn("ActualSynchronization.synchronize")(function* (
        snapshot: PerformanceSnapshot,
      ) {
        const syncCounts = yield* runActualSyncWithRetry(
          config,
          snapshot,
          clientFactory,
          fileSystem,
          healthCheck,
          retryPolicy.schedule,
        )
        yield* Effect.logInfo(
          `Actual sync finished. Created ${syncCounts.created} transactions, updated ${syncCounts.updated}, and deleted ${syncCounts.deletedDuplicates} duplicates.`,
        )
      })

      return ActualSynchronization.of({ synchronize })
    }),
  )

  static readonly live = this.layer.pipe(
    Layer.provide(ActualClientFactory.live),
    Layer.provide(ActualFileSystem.live),
    Layer.provide(ActualHealthCheck.layer((input, init) => globalThis.fetch(input, init))),
    Layer.provide(ActualRetryPolicy.live),
  )
}

const runActualSyncWithRetry = Effect.fn("ActualSynchronization.withRetry")(function* (
  config: ActualConfig,
  snapshot: PerformanceSnapshot,
  clientFactory: ActualClientFactory["Service"],
  fileSystem: ActualFileSystem["Service"],
  healthCheck: ActualHealthCheck["Service"],
  retrySchedule: Schedule.Schedule<Duration.Duration, ActualError>,
): Effect.fn.Return<SyncCounts, ActualError> {
  const schedule = retrySchedule.pipe(
    Schedule.while(({ input }) => input.retryable),
    Schedule.tap(({ input, duration, attempt }) =>
      Effect.logWarning(
        `Actual sync attempt ${attempt} failed with a retryable error: ${getErrorMessage(input)}. Retrying in ${Math.round(Duration.toMillis(duration) / 1000)}s.`,
      ),
    ),
  )

  return yield* runActualSyncAttempt(config, snapshot, clientFactory, fileSystem, healthCheck).pipe(
    Effect.retry(schedule),
  )
})

const runActualSyncAttempt = Effect.fn("ActualSynchronization.attempt")(function* (
  config: ActualConfig,
  snapshot: PerformanceSnapshot,
  clientFactory: ActualClientFactory["Service"],
  fileSystem: ActualFileSystem["Service"],
  healthCheck: ActualHealthCheck["Service"],
): Effect.fn.Return<SyncCounts, ActualError> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* fileSystem.reset()
      yield* healthCheck.check(config.serverUrl)

      const client = yield* Effect.acquireRelease(clientFactory.acquire(config), closeActualClient)

      yield* client.downloadBudget(config.syncId)
      return yield* syncDailyVariationTransactions(client, config, snapshot)
    }),
  )
})

const syncDailyVariationTransactions = Effect.fn(
  "ActualSynchronization.syncDailyVariationTransactions",
)(function* (
  client: ActualClient,
  config: ActualConfig,
  snapshot: PerformanceSnapshot,
): Effect.fn.Return<SyncCounts, ActualError> {
  const endingDate = DateTime.formatIsoDateUtc(yield* DateTime.now)
  const startingDate = DateTime.make(config.startingDate)

  if (Option.isNone(startingDate)) {
    return yield* new ActualInvalidStartingDate({
      startingDate: config.startingDate,
      retryable: false,
    })
  }

  const startingTimestamp = DateTime.toEpochMillis(startingDate.value)
  const balanceEntries = snapshot.balance.filter((entry) => entry.date >= startingTimestamp)
  const transactions = yield* client.getTransactions(
    config.fintualAccount,
    config.startingDate,
    endingDate,
  )
  const payeeId = yield* resolvePayeeId(client, config.payee)
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
        yield* client.createTransaction(config.fintualAccount, action.transaction)
        syncCounts.created += 1
        break
      }
      case "update": {
        yield* client.updateTransaction(action.id, action.transaction)
        syncCounts.updated += 1
        break
      }
      case "delete": {
        yield* client.deleteTransaction(action.id)
        syncCounts.deletedDuplicates += 1
        break
      }
    }
  }

  yield* client.sync()
  return syncCounts
})

const resolvePayeeId = Effect.fn("ActualSynchronization.resolvePayeeId")(function* (
  client: ActualClient,
  configuredPayee: string,
): Effect.fn.Return<string | undefined, ActualPayeesReadFailure> {
  const payees = yield* client.getPayees()
  const payee = payees.find((candidate) => candidate.name === configuredPayee)

  if (!payee) {
    yield* Effect.logInfo("Configured payee not found")
    return undefined
  }

  return payee.id
})

const closeActualClient = Effect.fn("ActualSynchronization.closeClient")(function* (
  client: ActualClient,
): Effect.fn.Return<void> {
  yield* client
    .shutdown()
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning(`Failed to shutdown Actual API: ${getErrorMessage(cause)}`),
      ),
    )
})

export function main(
  config: ActualConfig,
  snapshot: PerformanceSnapshot,
): Effect.Effect<void, ActualError> {
  return runMain(snapshot).pipe(
    Effect.provide(ActualSynchronization.live),
    Effect.provideService(ActualConfigService, config),
  )
}

const runMain = Effect.fn("Actual.main")(function* (snapshot: PerformanceSnapshot) {
  const actual = yield* ActualSynchronization
  yield* actual.synchronize(snapshot)
})
