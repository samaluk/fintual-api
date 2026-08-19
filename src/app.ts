import { Effect } from "effect"

import { ScheduleConfigService } from "./env.ts"
import { Job, type JobError } from "./job.ts"
import { runScheduler } from "./scheduler.ts"

export const runApplication = Effect.fn("App.runApplication")(function* (): Effect.fn.Return<
  void,
  JobError,
  ScheduleConfigService | Job
> {
  const schedule = yield* ScheduleConfigService
  const job = yield* Job

  if (schedule.mode === "schedule") {
    return yield* runScheduler(job.synchronize(), schedule)
  }

  yield* Effect.logInfo("Running task once...")
  yield* job.synchronize()
  yield* Effect.logInfo("Task completed.")
})
