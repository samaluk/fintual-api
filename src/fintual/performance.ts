import { Context, Effect, Layer, Option } from "effect"

import { Email2FAConfigService, FintualConfigService } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import {
  SnapshotWriter,
  validatePerformanceSnapshot,
  type PerformanceSnapshot,
} from "../performance-snapshot.ts"
import { Email2FACode, Email2FAService, Operational, TimedOut } from "./email-2fa.ts"
import { MalformedPerformanceSnapshot, type FintualError } from "./fintual-error.ts"
import { foldGoalPerformanceData } from "./fold.ts"
import { FintualProvider } from "./provider.ts"

export class FintualPerformance extends Context.Service<
  FintualPerformance,
  {
    fetchPerformanceSnapshot: Effect.Effect<PerformanceSnapshot, FintualError>
  }
>()("FintualPerformance") {
  static readonly layer = Layer.effect(
    FintualPerformance,
    Effect.gen(function* () {
      yield* FintualConfigService
      const provider = yield* FintualProvider
      const snapshotWriter = yield* SnapshotWriter
      const email2FAService = yield* acquireEmail2FAService()

      const fetchPerformanceSnapshot = Effect.gen(function* () {
        yield* provider.signIn(requestEmail2FACode(email2FAService))

        const reference = yield* provider.fetchReferenceGoalPerformanceData
        const recent = yield* provider.fetchRecentGoalPerformanceData

        const snapshot = yield* Effect.try({
          try: () => foldGoalPerformanceData(reference, recent),
          catch: (cause) =>
            new MalformedPerformanceSnapshot({
              issues: `Failed to fold Fintual performance data: ${getErrorMessage(cause)}`,
              cause,
            }),
        })

        const validatedSnapshot = yield* Effect.mapError(
          validatePerformanceSnapshot(snapshot),
          (cause) => new MalformedPerformanceSnapshot({ issues: cause.issues, cause }),
        )
        yield* snapshotWriter.write(validatedSnapshot)

        return validatedSnapshot
      }).pipe(Effect.withSpan("FintualPerformance.fetchPerformanceSnapshot"))

      return FintualPerformance.of({ fetchPerformanceSnapshot })
    }),
  )

  static readonly live = Layer.unwrap(
    Effect.gen(function* () {
      yield* FintualConfigService

      const email2FAConfig = yield* Email2FAConfigService

      return FintualPerformance.layer.pipe(
        Layer.provide(FintualProvider.layer),
        Layer.provide(Option.isSome(email2FAConfig) ? Email2FAService.live : Layer.empty),
        Layer.provide(SnapshotWriter.live),
      )
    }),
  )
}

const acquireEmail2FAService = Effect.fn("FintualPerformance.acquireEmail2FAService")(
  function* (): Effect.fn.Return<Option.Option<Email2FAService["Service"]>, never> {
    return yield* Effect.serviceOption(Email2FAService)
  },
)

const requestEmail2FACode =
  (
    email2FAService: Option.Option<Email2FAService["Service"]>,
  ): ((afterTimestamp: Date) => Effect.Effect<Email2FACode, TimedOut | Operational>) =>
  (afterTimestamp) =>
    Option.match(email2FAService, {
      onNone: () =>
        Effect.fail(
          new Operational({
            cause: new Error("Fintual email 2FA: Gmail IMAP credentials not configured"),
          }),
        ),
      onSome: (service) => service.get2FACode({ afterTimestamp }),
    })
