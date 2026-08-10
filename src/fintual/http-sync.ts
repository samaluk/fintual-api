import { Effect } from "effect"
import { error, log, trySync } from "../effect.ts"
import type { FintualConfig } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import { createAuthenticatedFintualIngestion } from "./authenticated-ingestion.ts"
import { get2FACodeFromEmail } from "./email-2fa.ts"
import { BALANCE_FILE_PATH, foldGoalPerformanceData, writePerformanceFile } from "./scraper.ts"

/**
 * Fetches performance via `initiate_login` → (e-mail 2FA) `finalize_login_web` → GraphQL.
 * Requires Gmail IMAP env vars for accounts with e-mail 2FA.
 */
function fetchFintualPerformanceHttp(config: FintualConfig): Effect.Effect<void, Error> {
  const fetchAuthenticatedGoalPerformance = createAuthenticatedFintualIngestion({
    fetch: globalThis.fetch,
    get2FACode: (options) => get2FACodeFromEmail(config.email2FA, options),
  })
  return Effect.gen(function* () {
    const { reference, recent } = yield* fetchAuthenticatedGoalPerformance({
      email: config.email,
      password: config.password,
      goalId: config.goalId,
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

export function runFintualSync(config: FintualConfig): Effect.Effect<void, Error> {
  return Effect.catchAll(fetchFintualPerformanceHttp(config), (cause) =>
    Effect.zipRight(error(`Error: ${getErrorMessage(cause)}`), Effect.fail(cause)),
  )
}
