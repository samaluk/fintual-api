import { Cause, Clock, Cron, Duration, Effect, Exit, Ref, Result, Schema, Scope } from "effect"

import type { JobError } from "./job.ts"

export interface SchedulerOptions {
  readonly cron: Cron.Cron
  readonly timezone: string
  readonly noOverlap: boolean
}

export interface ScheduleParseError {
  readonly _tag: "InvalidScheduleError"
  readonly message: string
  readonly input: string
  readonly cause: unknown
}

class InvalidScheduleError extends Schema.TaggedError<InvalidScheduleError>()(
  "InvalidScheduleError",
  {
    message: Schema.String,
    input: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const parseSchedule = (
  cron: string,
  timezone: string,
): Result.Result<Cron.Cron, ScheduleParseError> => {
  const parsed = Cron.parse(cron, timezone)
  if (Result.isFailure(parsed)) {
    return Result.fail(
      new InvalidScheduleError({
        message: parsed.failure.message,
        input: parsed.failure.input ?? cron,
        cause: parsed.failure,
      }),
    )
  }
  return Result.succeed(parsed.success)
}

export const runScheduler = Effect.fn("Scheduler.run")(function* (
  job: Effect.Effect<void, JobError>,
  options: SchedulerOptions,
): Effect.fn.Return<never, never> {
  const cron = options.cron
  const scope = yield* Scope.make()
  const running = yield* Ref.make(false)

  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const next = Cron.next(cron, now)
    yield* Effect.sleep(Duration.millis(next.getTime() - now))

    if (options.noOverlap && (yield* Ref.getAndSet(running, true))) {
      yield* Effect.logWarning("Skipping scheduled run; a previous run is still in progress")
      return
    }

    yield* Effect.forkIn(
      job.pipe(
        Effect.catchCause((cause) =>
          // Interruption must stop the scheduler, so only non-interrupt causes are logged.
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logError("Scheduled run failed", cause),
        ),
        Effect.ensuring(Ref.set(running, false)),
      ),
      scope,
    )
  })

  return yield* Effect.forever(tick).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
})
