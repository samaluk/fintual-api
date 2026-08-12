import { Cause, Clock, Cron, Duration, Effect, Ref, Result, Schema } from "effect"

export interface SchedulerOptions {
  readonly cron: string
  readonly timezone: string
  readonly noOverlap: boolean
}

export class InvalidScheduleError extends Schema.TaggedError<InvalidScheduleError>()(
  "InvalidScheduleError",
  {
    message: Schema.String,
    input: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const runScheduler = Effect.fn("Scheduler.run")(function* (
  job: Effect.Effect<unknown, unknown>,
  options: SchedulerOptions,
): Effect.fn.Return<never, InvalidScheduleError> {
  const parsed = Cron.parse(options.cron, options.timezone)
  if (Result.isFailure(parsed)) {
    return yield* new InvalidScheduleError({
      message: parsed.failure.message,
      input: parsed.failure.input ?? options.cron,
      cause: parsed.failure,
    })
  }

  const cron = parsed.success
  const running = yield* Ref.make(false)

  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const next = Cron.next(cron, new Date(now))
    yield* Effect.sleep(Duration.millis(next.getTime() - now))

    if (options.noOverlap && (yield* Ref.getAndSet(running, true))) {
      yield* Effect.logWarning("Skipping scheduled run; a previous run is still in progress")
      return
    }

    yield* job.pipe(
      Effect.catchCause((cause) =>
        // Interruption must stop the scheduler, so only non-interrupt causes are logged.
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("Scheduled run failed", cause),
      ),
      Effect.ensuring(Ref.set(running, false)),
    )
  })

  return yield* Effect.forever(tick)
})
