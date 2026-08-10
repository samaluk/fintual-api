import { Effect } from "effect"
import { error, log, trySync } from "../effect.ts"
import { getEnv } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import { fetchAuthenticatedGoalPerformance } from "./authenticated-ingestion.ts"
import { BALANCE_FILE_PATH, foldGoalPerformanceData, writePerformanceFile } from "./scraper.ts"

const GOAL_ID = getEnv("FINTUAL_GOAL_ID")

/**
 * Fetches performance via `initiate_login` → (e-mail 2FA) `finalize_login_web` → GraphQL.
 * Requires Gmail IMAP env vars for accounts with e-mail 2FA.
 */
function fetchFintualPerformanceHttp(): Effect.Effect<void, Error> {
  const email = getEnv("FINTUAL_USER_EMAIL")
  const password = getEnv("FINTUAL_USER_PASSWORD")

  return Effect.gen(function* () {
    const { reference, recent } = yield* fetchAuthenticatedGoalPerformance({
      email,
      password,
      goalId: GOAL_ID,
    })

    const performanceData = yield* trySync({
      try: () => foldGoalPerformanceData(reference, recent),
      catch: "Failed to fold Fintual performance data",
    })
    if (!performanceData) {
      return yield* Effect.fail(new Error("Fintual HTTP sync: missing Goal Performance Data"))
    }

    yield* writePerformanceFile(performanceData)
    yield* log(`Balance data saved to ${BALANCE_FILE_PATH}`)
  })
}

export const runFintualSync: Effect.Effect<void, Error> = Effect.catchAll(
  fetchFintualPerformanceHttp(),
  (cause) => Effect.zipRight(error(`Error: ${getErrorMessage(cause)}`), Effect.fail(cause)),
)
