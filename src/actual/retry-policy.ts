import { Context, Duration, Layer, Schedule } from "effect"

import type { ActualError } from "./actual-error.ts"

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

export class ActualRetryPolicy extends Context.Service<
  ActualRetryPolicy,
  {
    readonly schedule: ActualRetrySchedule
  }
>()("ActualRetryPolicy") {
  static readonly live = Layer.succeed(
    ActualRetryPolicy,
    ActualRetryPolicy.of({ schedule: actualRetrySchedule }),
  )
}
