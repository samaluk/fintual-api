import "../env"
import { ImapFlow } from "imapflow"
import { parse as parseHtml } from "node-html-parser"

const IMAP_HOST = process.env.IMAP_HOST ?? ""
const IMAP_PORT = Number.parseInt(process.env.IMAP_PORT ?? "993", 10)
const IMAP_USER = process.env.IMAP_USER ?? ""
const IMAP_PASSWORD = process.env.IMAP_PASSWORD ?? ""
const FINTUAL_2FA_SENDER = process.env.FINTUAL_2FA_SENDER ?? "notificaciones@fintual.com"
const FINTUAL_2FA_SUBJECT = process.env.FINTUAL_2FA_SUBJECT ?? "código"

interface Email2FAOptions {
	/** Timestamp after which to look for emails */
	afterTimestamp: Date
	/** Maximum time to wait for the email in milliseconds (default: 120000 = 2 minutes) */
	timeoutMs?: number
	/** Polling interval in milliseconds (default: 3000 = 3 seconds) */
	pollIntervalMs?: number
}

/**
 * Connects to an IMAP server and polls for a 2FA email from Fintual.
 * Extracts and returns the 6-digit verification code.
 */
export async function get2FACodeFromEmail(options: Email2FAOptions): Promise<string | null> {
	const { afterTimestamp, timeoutMs = 120000, pollIntervalMs = 3000 } = options

	if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
		console.log("IMAP credentials not configured, skipping automatic 2FA retrieval")
		return null
	}

	console.log(`Connecting to IMAP server ${IMAP_HOST}:${IMAP_PORT}...`)

	const client = new ImapFlow({
		host: IMAP_HOST,
		port: IMAP_PORT,
		secure: true,
		auth: {
			user: IMAP_USER,
			pass: IMAP_PASSWORD,
		},
		logger: false,
	})

	let code: string | null = null

	try {
		await client.connect()
		console.log("Connected to IMAP server")

		const startTime = Date.now()

		while (Date.now() - startTime < timeoutMs) {
			code = await searchForCode(client, afterTimestamp)
			if (code) {
				console.log(`Found 2FA code: ${code}`)
				break
			}

			console.log(`Waiting for 2FA email... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`)
			await sleep(pollIntervalMs)
		}

		if (!code) {
			console.log("Timeout waiting for 2FA email")
		}
	} catch (error) {
		console.error("Error fetching 2FA code from email:", error)
	} finally {
		console.log("Closing IMAP connection...")
		client.close()
		console.log("IMAP connection closed")
	}

	return code
}

async function searchForCode(client: ImapFlow, afterTimestamp: Date): Promise<string | null> {
	const lock = await client.getMailboxLock("INBOX")

	try {
		// Search for emails from Fintual received after the login was initiated
		const searchCriteria = {
			from: FINTUAL_2FA_SENDER,
			since: afterTimestamp,
		}

		const messages = client.fetch(searchCriteria, {
			envelope: true,
			source: true,
		})

		for await (const message of messages) {
			const envelope = message.envelope
			const subject = envelope?.subject ?? ""

			// Check if subject matches the pattern (case-insensitive)
			if (subject !== FINTUAL_2FA_SUBJECT) {
				continue
			}


			// Check if the email was received after our timestamp
			const emailDate = envelope?.date
			if (emailDate && emailDate < afterTimestamp) {
				continue
			}

			// Get email body and extract the code
			const source = message.source?.toString() ?? ""
			const code = extractCodeFromEmail(source)

			if (code) {
				return code
			}
		}

		return null
	} finally {
		lock.release()
	}
}

/**
 * Extracts a 6-digit code from the email content.
 * Parses the HTML to find the code in the styled <td> element.
 */
function extractCodeFromEmail(emailContent: string): string | null {
	// Extract the HTML part from the multipart email
	const htmlMatch = emailContent.match(/Content-Type: text\/html[\s\S]*?\n\n([\s\S]*?)(?:------=|$)/i)
	if (!htmlMatch) {
		console.log("No HTML content found in email")
		return extractCodeFromPlainText(emailContent)
	}

	// Decode quoted-printable encoding
	let htmlContent = htmlMatch[1]
	htmlContent = decodeQuotedPrintable(htmlContent)

	// Parse the HTML
	const root = parseHtml(htmlContent)

	// Strategy 1: Find <td> with the specific code styling (font-size: 34px, letter-spacing: 0.5rem)
	const allTds = root.querySelectorAll("td")
	for (const td of allTds) {
		const style = td.getAttribute("style") ?? ""
		// Look for the distinctive styling of the code element
		if (style.includes("font-size: 34px") && style.includes("letter-spacing")) {
			const text = td.text.trim()
			const codeMatch = text.match(/^\d{6}$/)
			if (codeMatch) {
				return codeMatch[0]
			}
		}
	}

	// Strategy 2: Find a <td> containing only a 6-digit number
	for (const td of allTds) {
		const text = td.text.trim()
		if (/^\d{6}$/.test(text)) {
			return text
		}
	}

	// Fallback: extract from plain text
	return extractCodeFromPlainText(emailContent)
}

/**
 * Decodes quoted-printable encoded content.
 */
function decodeQuotedPrintable(str: string): string {
	return str
		// Remove soft line breaks (= at end of line)
		.replace(/=\r?\n/g, "")
		// Decode hex-encoded characters
		.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * Fallback: Extract code from plain text content.
 */
function extractCodeFromPlainText(content: string): string | null {
	// Decode quoted-printable first
	const decoded = decodeQuotedPrintable(content)

	// Look for 6-digit codes after "cuenta" (as in "entrar a tu cuenta 094485")
	const afterCuentaPattern = /cuenta\s+(\d{6})/i
	const afterCuentaMatch = decoded.match(afterCuentaPattern)
	if (afterCuentaMatch?.[1]) {
		return afterCuentaMatch[1]
	}

	// Fallback: find any standalone 6-digit number
	const sixDigitPattern = /\b(\d{6})\b/g
	const matches = decoded.match(sixDigitPattern)
	if (matches && matches.length > 0) {
		return matches[0]
	}

	return null
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
