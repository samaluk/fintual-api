import * as fs from "node:fs"

import { Context, DateTime, Duration, Effect, Layer, Option, Schedule } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

import { ActualClientFactory, type ActualClient } from "./actual/actual-client.ts"
import {
  ActualDataDirectoryFailure,
  ActualHealthCheckFailure,
  ActualInvalidStartingDate,
  type ActualError,
  type ActualPayeesReadFailure,
} from "./actual/actual-error.ts"
import { planReconciliation } from "./actual/reconciliation-policy.ts"
import { ActualConfigService, type ActualConfig } from "./env.ts"
import { getErrorMessage } from "./log.ts"
import type { PerformanceSnapshot } from "./performance-snapshot.ts"

export type { ActualError } from "./actual/actual-error.ts"

const ACTUAL_DATA_DIR = "./tmp/actual-data"
const HEALTH_CHECK_TIMEOUT = Duration.millis(10_000)

const MAX_SYNC_ATTEMPTS = 5
const INITIAL_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 60_000

type ActualRetrySchedule = Schedule.Schedule<Duration.Duration, ActualError>

const actualRetrySchedule: ActualRetrySchedule = Schedule.max([
  Schedule.min([
    Schedule.exponential(Duration.millis(INITIAL_RETRY_DELAY_MS)),
    Schedule.spaced(Duration.millis(MAX_RETRY_DELAY_MS)),
  ]),
  Schedule.recurs(MAX_SYNC_ATTEMPTS - 1),
]).pipe(Schedule.jittered, Schedule.setInputType<ActualError>())

interface SyncCounts {
  readonly created: number
  readonly updated: number
  readonly deletedDuplicates: number
}

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
      const httpClient = yield* HttpClient.HttpClient

      const synchronize = Effect.fn("ActualSynchronization.synchronize")(function* (
        snapshot: PerformanceSnapshot,
      ) {
        const syncCounts = yield* runActualSyncWithRetry(
          config,
          snapshot,
          clientFactory,
          httpClient,
        )
        yield* Effect.logInfo(
          `Actual sync finished. Created ${syncCounts.created} transactions, updated ${syncCounts.updated}, and deleted ${syncCounts.deletedDuplicates} duplicates.`,
        )
      })

      return ActualSynchronization.of({ synchronize })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

  static readonly live = this.layer.pipe(Layer.provide(ActualClientFactory.live))
}

const runActualSyncWithRetry = Effect.fn("ActualSynchronization.withRetry")(function* (
  config: ActualConfig,
  snapshot: PerformanceSnapshot,
  clientFactory: ActualClientFactory["Service"],
  httpClient: HttpClient.HttpClient,
): Effect.fn.Return<SyncCounts, ActualError> {
  const schedule = actualRetrySchedule.pipe(
    Schedule.while(({ input }) => input.retryable),
    Schedule.tap(({ input, duration, attempt }) =>
      Effect.logWarning(
        `Actual sync attempt ${attempt} failed with a retryable error: ${getErrorMessage(input)}. Retrying in ${Math.round(Duration.toMillis(duration) / 1000)}s.`,
      ),
    ),
  )

  return yield* runActualSyncAttempt(config, snapshot, clientFactory, httpClient).pipe(
    Effect.retry(schedule),
  )
})

const runActualSyncAttempt = Effect.fn("ActualSynchronization.attempt")(function* (
  config: ActualConfig,
  snapshot: PerformanceSnapshot,
  clientFactory: ActualClientFactory["Service"],
  httpClient: HttpClient.HttpClient,
): Effect.fn.Return<SyncCounts, ActualError> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* resetDataDirectory()
      yield* checkHealth(httpClient, config.serverUrl)

      const client = yield* Effect.acquireRelease(clientFactory.acquire(config), closeActualClient)

      yield* client.downloadBudget(config.syncId)
      return yield* syncDailyVariationTransactions(client, config, snapshot)
    }),
  )
})

const resetDataDirectory = Effect.fn("ActualSynchronization.resetDataDirectory")(
  function* (): Effect.fn.Return<void, ActualDataDirectoryFailure> {
    return yield* Effect.try({
      try: () => {
        fs.rmSync(ACTUAL_DATA_DIR, { recursive: true, force: true })
        fs.mkdirSync(ACTUAL_DATA_DIR, { recursive: true })
      },
      catch: (cause) => new ActualDataDirectoryFailure({ cause, retryable: false }),
    }).pipe(Effect.withSpan("ActualSynchronization.resetDataDirectory"))
  },
)

function getHealthUrl(serverUrl: string): string {
  const normalizedBaseUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl
  return `${normalizedBaseUrl}/health`
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

const checkHealth = Effect.fn("ActualSynchronization.checkHealth")(function* (
  httpClient: HttpClient.HttpClient,
  serverUrl: string,
): Effect.fn.Return<void, ActualHealthCheckFailure> {
  const healthUrl = getHealthUrl(serverUrl)
  const response = yield* httpClient.execute(HttpClientRequest.get(healthUrl)).pipe(
    Effect.mapError(
      (cause) =>
        new ActualHealthCheckFailure({
          url: healthUrl,
          cause,
          retryable: true,
        }),
    ),
    Effect.timeoutOrElse({
      duration: HEALTH_CHECK_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ActualHealthCheckFailure({
            url: healthUrl,
            cause: new Error(
              `health endpoint timed out after ${Duration.toMillis(HEALTH_CHECK_TIMEOUT)}ms`,
            ),
            retryable: true,
          }),
        ),
    }),
  )

  if (response.status >= 200 && response.status < 300) {
    return
  }

  return yield* new ActualHealthCheckFailure({
    url: healthUrl,
    status: response.status,
    cause: new Error(`health endpoint returned HTTP ${response.status}`),
    retryable: isRetryableStatus(response.status),
  })
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

  yield* client.sync
  return syncCounts
})

const resolvePayeeId = Effect.fn("ActualSynchronization.resolvePayeeId")(function* (
  client: ActualClient,
  configuredPayee: string,
): Effect.fn.Return<string | undefined, ActualPayeesReadFailure> {
  const payees = yield* client.getPayees
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
  yield* client.shutdown.pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`Failed to shutdown Actual API: ${getErrorMessage(cause)}`),
    ),
  )
})
