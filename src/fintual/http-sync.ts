import { Effect } from "effect"
import { error, trySync } from "../effect.ts"
import type { FintualConfig } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import {
  validatePerformanceSnapshot,
  writePerformanceSnapshot,
  type PerformanceSnapshot,
} from "../performance-snapshot.ts"
import { createAuthenticatedFintualIngestion } from "./authenticated-ingestion.ts"
import { get2FACodeFromEmail } from "./email-2fa.ts"
import { foldGoalPerformanceData } from "./scraper.ts"

/**
 * Fetches performance via `initiate_login` → (e-mail 2FA) `finalize_login_web` → GraphQL.
 * Requires Gmail IMAP env vars for accounts with e-mail 2FA.
 */
function fetchFintualPerformanceHttp(
  config: FintualConfig,
): Effect.Effect<PerformanceSnapshot, Error> {
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

    const snapshot = yield* trySync({
      try: () => foldGoalPerformanceData(reference, recent),
      catch: "Failed to fold Fintual performance data",
    })

    const validatedSnapshot = yield* validatePerformanceSnapshot(snapshot)
    yield* writePerformanceSnapshot(validatedSnapshot)

    return validatedSnapshot
  })
}

export function runFintualSync(config: FintualConfig): Effect.Effect<PerformanceSnapshot, Error> {
  return Effect.catch(fetchFintualPerformanceHttp(config), (cause) =>
    Effect.andThen(error(`Error: ${getErrorMessage(cause)}`), Effect.fail(cause)),
  )
}
