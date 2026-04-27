import { Effect } from "effect"
import { main as mainActual } from "./actual.ts"
import { log } from "./effect.ts"
import { assertRequiredEnv } from "./env.ts"
import { runFintualSync } from "./fintual/http-sync.ts"
import "./env.ts"

const REQUIRED_SYNC_ENV_NAMES = [
  "ACTUAL_SERVER_URL",
  "ACTUAL_PASSWORD",
  "ACTUAL_SYNC_ID",
  "ACTUAL_FINTUAL_ACCOUNT",
  "FINTUAL_USER_EMAIL",
  "FINTUAL_USER_PASSWORD",
  "FINTUAL_GOAL_ID",
  "GMAIL_USER_EMAIL",
  "GMAIL_APP_PASSWORD",
] satisfies string[]

export const runJob: Effect.Effect<void, Error> = Effect.gen(function* () {
  yield* assertRequiredEnv(REQUIRED_SYNC_ENV_NAMES)
  yield* log("Running job...")
  yield* runFintualSync
  yield* mainActual
  yield* log("Job finished.")
})
