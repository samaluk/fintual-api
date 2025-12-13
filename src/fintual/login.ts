import "../env"
import type { Page } from "playwright"
import { get2FACodeFromEmail } from "./email-2fa"

const USER_EMAIL = process.env.FINTUAL_USER_EMAIL ?? ""
const USER_PASSWORD = process.env.FINTUAL_USER_PASSWORD ?? ""

export async function login(page: Page) {
	const emailLocator = page.locator('input[name="email"]')
	const passwordLocator = page.locator('input[name="password"]')

	await emailLocator.fill(USER_EMAIL)
	await passwordLocator.fill(USER_PASSWORD)

	const loginButtonLocator = page.getByRole("button", { name: "Entrar" })

	// Record timestamp before login to filter emails received after this point
	const loginTimestamp = new Date()

	await Promise.all([loginButtonLocator.click(), page.waitForLoadState("networkidle", { timeout: 30000 })])

	const twoFAText = "Escribe el código que te mandamos al correo"
	const twoFAPrompt = page.locator(`text=${twoFAText}`).first()

	const errorText = "Correo o contraseña incorrectos"
	const errorPrompt = page.locator(`text=${errorText}`).first()
	const result = await Promise.race([
		twoFAPrompt
			.waitFor({ state: "visible", timeout: 30000 })
			.then(() => "2fa")
			.catch(() => null),
		errorPrompt
			.waitFor({ state: "visible", timeout: 30000 })
			.then(() => "fail")
			.catch(() => null),
	])
	console.log("Login result:", result)

	if (result === "fail") {
		console.log("Login failed")
		return false
	}

	if (result === "2fa") {
		console.log("2FA required, attempting to fetch code from email...")

		// Try automatic email fetch first
		let code = await get2FACodeFromEmail({
			afterTimestamp: loginTimestamp,
			timeoutMs: 120000, // 2 minutes
			pollIntervalMs: 3000, // 3 seconds
		})

		// Fallback to manual input if automatic fetch fails
		if (!code) {
			console.log("Automatic 2FA fetch failed, falling back to manual input...")
			const readline = await import("node:readline/promises")
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			})
			code = await rl.question("Enter the 2FA code sent to your email: ")
			rl.close()
		}

		// Fill the code into the input field
		const codeInput = page.locator('input[aria-label="Código"]')
		await codeInput.fill(code)
		await codeInput.press("Enter")
		await page.waitForTimeout(2000)
	}

	console.log("Login successful")
	await page.waitForTimeout(2000)

	return true
}
