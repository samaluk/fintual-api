import type { Locator, Page } from "playwright"
import { getEnv } from "../env.ts"
import { get2FACodeFromEmail } from "./email-2fa.ts"

const USER_EMAIL = getEnv("FINTUAL_USER_EMAIL")
const USER_PASSWORD = getEnv("FINTUAL_USER_PASSWORD")
const LOGIN_TIMEOUT_MS = 30000
const POST_LOGIN_WAIT_MS = 2000
const LOGIN_BUTTON_ENABLE_TIMEOUT_MS = 10000
const LOGIN_BUTTON_POLL_INTERVAL_MS = 250

type LoginStatus = "authenticated" | "invalid_credentials" | "requires_2fa"

export async function login(page: Page): Promise<boolean> {
	ensureCredentialsConfigured()

	const emailInput = page.locator('input[name="email"]')
	const passwordInput = page.locator('input[name="password"]')
	const loginButton = page.getByRole("button", { name: "Entrar" })

	await page.waitForLoadState("domcontentloaded")
	await page.waitForLoadState("networkidle", { timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined)
	await emailInput.waitFor({ state: "visible", timeout: LOGIN_TIMEOUT_MS })
	await passwordInput.waitFor({ state: "visible", timeout: LOGIN_TIMEOUT_MS })
	await page.waitForTimeout(1000)

	await fillInput(emailInput, USER_EMAIL)
	await fillInput(passwordInput, USER_PASSWORD)
	await waitForLoginButtonEnabled(page, emailInput, passwordInput, loginButton)

	const loginTimestamp = new Date()

	await Promise.all([loginButton.click(), page.waitForLoadState("networkidle", { timeout: LOGIN_TIMEOUT_MS })])

	const loginStatus = await waitForLoginStatus(page)
	console.log("Login result:", loginStatus)

	if (loginStatus === "invalid_credentials") {
		console.log("Login failed")
		return false
	}

	if (loginStatus === "requires_2fa") {
		const completedTwoFactorLogin = await completeTwoFactorLogin(page, loginTimestamp)
		if (!completedTwoFactorLogin) {
			return false
		}
	}

	console.log("Login successful")
	await page.waitForTimeout(POST_LOGIN_WAIT_MS)

	return true
}

function ensureCredentialsConfigured(): void {
	if (!USER_EMAIL || !USER_PASSWORD) {
		throw new Error("Missing FINTUAL_USER_EMAIL or FINTUAL_USER_PASSWORD")
	}
}

async function fillInput(input: Locator, value: string): Promise<void> {
	await input.click()
	await input.fill("")
	await input.pressSequentially(value, { delay: 50 })
	await input.dispatchEvent("input")
	await input.dispatchEvent("change")
	await input.blur()
}

async function waitForLoginButtonEnabled(
	page: Page,
	emailInput: Locator,
	passwordInput: Locator,
	loginButton: Locator,
): Promise<void> {
	const startedAt = Date.now()

	while (Date.now() - startedAt < LOGIN_BUTTON_ENABLE_TIMEOUT_MS) {
		if (await loginButton.isEnabled()) {
			return
		}

		await page.waitForTimeout(LOGIN_BUTTON_POLL_INTERVAL_MS)
	}

	const buttonDisabled = await loginButton.evaluate((button) => button.hasAttribute("disabled"))
	const diagnostics = await page.evaluate(() => {
		const emailField = document.querySelector('input[name="email"]') as HTMLInputElement | null
		const passwordField = document.querySelector('input[name="password"]') as HTMLInputElement | null
		const submitButton = document.querySelector('button[type="submit"]') as HTMLButtonElement | null

		return {
			title: document.title,
			emailValid: emailField?.checkValidity() ?? null,
			passwordValid: passwordField?.checkValidity() ?? null,
			emailType: emailField?.type ?? null,
			passwordType: passwordField?.type ?? null,
			buttonText: submitButton?.textContent?.trim() ?? null,
			buttonDisabledProperty: submitButton?.disabled ?? null,
		}
	})

	throw new Error(
		`Login button remained disabled after filling credentials (disabled=${buttonDisabled}, emailValid=${diagnostics.emailValid}, passwordValid=${diagnostics.passwordValid}, title=${diagnostics.title}, emailType=${diagnostics.emailType}, passwordType=${diagnostics.passwordType}, buttonText=${diagnostics.buttonText}, buttonDisabledProperty=${diagnostics.buttonDisabledProperty})`,
	)
}

async function waitForLoginStatus(page: Page): Promise<LoginStatus> {
	const twoFactorPrompt = page.locator("text=Escribe el c\u00f3digo que te mandamos al correo").first()
	const invalidCredentialsPrompt = page.locator("text=Correo o contrase\u00f1a incorrectos").first()

	const loginStatus = await Promise.race([
		twoFactorPrompt
			.waitFor({ state: "visible", timeout: LOGIN_TIMEOUT_MS })
			.then(() => "requires_2fa" as const)
			.catch(() => null),
		invalidCredentialsPrompt
			.waitFor({ state: "visible", timeout: LOGIN_TIMEOUT_MS })
			.then(() => "invalid_credentials" as const)
			.catch(() => null),
	])

	if (loginStatus) {
		return loginStatus
	}

	return "authenticated"
}

async function completeTwoFactorLogin(page: Page, loginTimestamp: Date): Promise<boolean> {
	console.log("2FA required, attempting to fetch code from Gmail...")

	const code = await get2FACodeFromEmail({
		afterTimestamp: loginTimestamp,
	})

	if (!code) {
		console.error("Automatic 2FA retrieval failed. Gmail OAuth must be configured for unattended runs.")
		return false
	}

	const codeInput = page.locator('input[aria-label="C\u00f3digo"]')
	await codeInput.fill(code)
	await codeInput.press("Enter")
	await page.waitForTimeout(POST_LOGIN_WAIT_MS)

	return true
}
