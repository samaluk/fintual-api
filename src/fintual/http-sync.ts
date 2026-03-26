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
async function fetchFintualPerformanceHttp(): Promise<void> {
	const session = createFintualHttpSession()
	const email = getEnv("FINTUAL_USER_EMAIL")
	const password = getEnv("FINTUAL_USER_PASSWORD")

	await session.loadSignInPage()

	const loginResponse = await session.initiateLogin(email, password)
	const loginBody = await loginResponse.text()

	if (!loginResponse.ok) {
		throw new Error(`Fintual initiate_login failed (${loginResponse.status}): ${loginBody.slice(0, 400)}`)
	}

	if (loginResponse.status === 201) {
		const loginStartedAt = new Date()
		console.log("Fintual: login initiated (e-mail 2FA expected).")
		const code = await get2FACodeFromEmail({
			afterTimestamp: loginStartedAt,
			timeoutMs: HTTP_2FA_EMAIL_TIMEOUT_MS,
		})
		if (!code) {
			throw new Error(
				"Fintual HTTP sync: no 2FA code from Gmail (check GMAIL_* and FINTUAL_2FA_SENDER; confirm the 2FA email reached Inbox).",
			)
		}

		const finalizeResponse = await session.finalizeLoginWeb(email, password, code)
		const finalizeBody = await finalizeResponse.text()
		if (!finalizeResponse.ok) {
			throw new Error(`Fintual finalize_login_web failed (${finalizeResponse.status}): ${finalizeBody.slice(0, 400)}`)
		}
	} else if (loginResponse.status !== 200) {
		throw new Error(`Fintual initiate_login: unexpected status ${loginResponse.status}: ${loginBody.slice(0, 400)}`)
	}

	const sixMonthData = await getGoalPerformanceWithCookies(
		session.cookieHeader(),
		GOAL_ID,
		TimeIntervalCode.LastSixMonths,
	)
	const lastMonthData = await getGoalPerformanceWithCookies(session.cookieHeader(), GOAL_ID, TimeIntervalCode.LastMonth)

	const performanceData = foldGoalPerformanceData(sixMonthData, lastMonthData)
	if (!performanceData) {
		throw new Error(
			`Fintual HTTP sync: missing GraphQL data (session may require 2FA or extra auth). Login body preview: ${loginBody.slice(0, 300)}`,
		)
	}

	writePerformanceFile(performanceData)
	console.log(`Balance data saved to ${BALANCE_FILE_PATH}`)
}

export async function runFintualSync(): Promise<void> {
	try {
		await fetchFintualPerformanceHttp()
	} catch (error) {
		console.error(`Error: ${getErrorMessage(error)}`)
		process.exit(1)
	}
}
