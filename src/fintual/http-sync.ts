import { Effect } from "effect"
import { error, log, tryPromise, trySync } from "../effect.ts"
import { getEnv } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import { get2FACodeFromEmail } from "./email-2fa.ts"
import { createFintualHttpSession } from "./http-session.ts"
import { getGoalPerformanceWithCookies, TimeIntervalCode } from "./new-performance.ts"
import { BALANCE_FILE_PATH, foldGoalPerformanceData, writePerformanceFile } from "./scraper.ts"

const GOAL_ID = getEnv("FINTUAL_GOAL_ID")

const HTTP_2FA_EMAIL_TIMEOUT_MS = 120_000

/**
 * Fetches performance via `initiate_login` → (e-mail 2FA) `finalize_login_web` → GraphQL.
 * Requires Gmail IMAP env vars for accounts with e-mail 2FA.
 */
function fetchFintualPerformanceHttp(): Effect.Effect<void, Error> {
  const session = createFintualHttpSession()
  const email = getEnv("FINTUAL_USER_EMAIL")
  const password = getEnv("FINTUAL_USER_PASSWORD")

  return Effect.gen(function* () {
    yield* session.loadSignInPage()

    const loginResponse = yield* session.initiateLogin(email, password)
    const loginBody = yield* tryPromise({
      try: () => loginResponse.text(),
      catch: "Failed to read Fintual initiate_login response body",
    })

    if (!loginResponse.ok) {
      return yield* Effect.fail(
        new Error(
          `Fintual initiate_login failed (${loginResponse.status}): ${loginBody.slice(0, 400)}`,
        ),
      )
    }

    if (loginResponse.status === 201) {
      const loginStartedAt = new Date()
      yield* log("Fintual: login initiated (e-mail 2FA expected).")
      const code = yield* get2FACodeFromEmail({
        afterTimestamp: loginStartedAt,
        timeoutMs: HTTP_2FA_EMAIL_TIMEOUT_MS,
      })
      if (!code) {
        return yield* Effect.fail(
          new Error(
            "Fintual HTTP sync: no 2FA code from Gmail (check GMAIL_* and FINTUAL_2FA_SENDER; confirm the 2FA email reached Inbox).",
          ),
        )
      }

      const finalizeResponse = yield* session.finalizeLoginWeb(email, password, code)
      const finalizeBody = yield* tryPromise({
        try: () => finalizeResponse.text(),
        catch: "Failed to read Fintual finalize_login_web response body",
      })
      if (!finalizeResponse.ok) {
        return yield* Effect.fail(
          new Error(
            `Fintual finalize_login_web failed (${finalizeResponse.status}): ${finalizeBody.slice(0, 400)}`,
          ),
        )
      }
    } else if (loginResponse.status !== 200) {
      return yield* Effect.fail(
        new Error(
          `Fintual initiate_login: unexpected status ${loginResponse.status}: ${loginBody.slice(0, 400)}`,
        ),
      )
    }

    const sixMonthData = yield* getGoalPerformanceWithCookies(
      session.cookieHeader(),
      GOAL_ID,
      TimeIntervalCode.LastSixMonths,
    )
    const lastMonthData = yield* getGoalPerformanceWithCookies(
      session.cookieHeader(),
      GOAL_ID,
      TimeIntervalCode.LastMonth,
    )

    const performanceData = yield* trySync({
      try: () => foldGoalPerformanceData(sixMonthData, lastMonthData),
      catch: "Failed to fold Fintual performance data",
    })
    if (!performanceData) {
      return yield* Effect.fail(
        new Error(
          `Fintual HTTP sync: missing GraphQL data (session may require 2FA or extra auth). Login body preview: ${loginBody.slice(0, 300)}`,
        ),
      )
    }

    yield* writePerformanceFile(performanceData)
    yield* log(`Balance data saved to ${BALANCE_FILE_PATH}`)
  })
}

export const runFintualSync: Effect.Effect<void, Error> = Effect.catchAll(
  fetchFintualPerformanceHttp(),
  (cause) => Effect.zipRight(error(`Error: ${getErrorMessage(cause)}`), Effect.fail(cause)),
)
