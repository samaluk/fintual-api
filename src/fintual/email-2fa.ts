import { getEnv } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import { google } from "googleapis"
import type { gmail_v1 } from "googleapis"

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_RESULTS = 10

const GMAIL_CLIENT_ID = getEnv("GMAIL_CLIENT_ID")
const GMAIL_CLIENT_SECRET = getEnv("GMAIL_CLIENT_SECRET")
const GMAIL_REFRESH_TOKEN = getEnv("GMAIL_REFRESH_TOKEN")
const GMAIL_USER_EMAIL = getEnv("GMAIL_USER_EMAIL", "me")
const FINTUAL_2FA_SENDER = getEnv("FINTUAL_2FA_SENDER", "notificaciones@fintual.com")
const FINTUAL_2FA_SUBJECT = getEnv("FINTUAL_2FA_SUBJECT", "Código para entrar")

interface Email2FAOptions {
	afterTimestamp: Date
	timeoutMs?: number
	pollIntervalMs?: number
}

export async function get2FACodeFromEmail(options: Email2FAOptions): Promise<string | null> {
	const { afterTimestamp, timeoutMs = DEFAULT_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = options

	if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
		console.log("Gmail API credentials not configured, skipping automatic 2FA retrieval")
		return null
	}

	console.log("Connecting to Gmail API for automatic 2FA retrieval...")
	const gmailClient = createGmailClient()
	const startedAt = Date.now()

	try {
		while (Date.now() - startedAt < timeoutMs) {
			const code = await searchForCode(gmailClient, afterTimestamp)
			if (code) {
				console.log("2FA code retrieved from Gmail.")
				return code
			}

			const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
			console.log(`Waiting for 2FA email... (${elapsedSeconds}s elapsed)`)
			await sleep(pollIntervalMs)
		}
	} catch (error) {
		console.error(`Error fetching 2FA code from Gmail API: ${getErrorMessage(error)}`)
		return null
	}

	console.log("Timeout waiting for 2FA email")
	return null
}

function createGmailClient(): gmail_v1.Gmail {
	const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET)
	auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN })

	return google.gmail({ version: "v1", auth })
}

async function searchForCode(gmailClient: gmail_v1.Gmail, afterTimestamp: Date): Promise<string | null> {
	const query = buildMessageQuery(afterTimestamp)
	const response = await gmailClient.users.messages.list({
		userId: GMAIL_USER_EMAIL,
		q: query,
		maxResults: MAX_RESULTS,
	})

	for (const message of response.data.messages ?? []) {
		if (!message.id) {
			continue
		}

		const fullMessage = await gmailClient.users.messages.get({
			userId: GMAIL_USER_EMAIL,
			id: message.id,
			format: "full",
		})

		const code = extractCodeFromMessage(fullMessage.data)
		if (code) {
			return code
		}
	}

	return null
}

function buildMessageQuery(afterTimestamp: Date): string {
	const afterUnixTimestamp = Math.floor(afterTimestamp.getTime() / 1000)
	const queryParts = [
		`from:${FINTUAL_2FA_SENDER}`,
		`subject:"${escapeGmailQueryValue(FINTUAL_2FA_SUBJECT)}"`,
		`after:${afterUnixTimestamp}`,
	]

	return queryParts.join(" ")
}

function extractCodeFromMessage(message: gmail_v1.Schema$Message): string | null {
	const sources = collectMessageSources(message)

	for (const source of sources) {
		const code = extractCodeFromText(source)
		if (code) {
			return code
		}
	}

	return null
}

function collectMessageSources(message: gmail_v1.Schema$Message): string[] {
	const sources: string[] = []

	if (message.snippet) {
		sources.push(message.snippet)
	}

	collectMessageTextParts(message.payload, sources)

	return sources
}

function collectMessageTextParts(part: gmail_v1.Schema$MessagePart | undefined, output: string[]): void {
	if (!part) {
		return
	}

	if (part.body?.data && part.mimeType?.startsWith("text/")) {
		output.push(decodeBase64Url(part.body.data))
	}

	for (const childPart of part.parts ?? []) {
		collectMessageTextParts(childPart, output)
	}
}

function decodeBase64Url(encoded: string): string {
	const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/")
	const missingPadding = normalized.length % 4
	const padded = missingPadding === 0 ? normalized : `${normalized}${"=".repeat(4 - missingPadding)}`

	return Buffer.from(padded, "base64").toString("utf8")
}

function decodeQuotedPrintable(value: string): string {
	return value
		.replaceAll(/=\r?\n/g, "")
		.replaceAll(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
}

function extractCodeFromText(rawContent: string): string | null {
	const decodedContent = decodeQuotedPrintable(rawContent)
	const htmlAsText = decodedContent.replaceAll(/<[^>]*>/g, " ")
	const collapsedText = htmlAsText.replaceAll(/\s+/g, " ")
	const candidates = collectCandidateCodes(collapsedText)

	for (const candidate of candidates) {
		if (candidate !== "000000") {
			return candidate
		}
	}

	return null
}

function collectCandidateCodes(text: string): string[] {
	const orderedCandidates: string[] = []
	const preferredPatterns = [
		/(?:codigo|c\u00f3digo)\D{0,20}(\d{6})/gi,
		/(?:entrar(?:\s+a)?\s+tu\s+cuenta)\D{0,20}(\d{6})/gi,
		/(?:cuenta)\D{0,20}(\d{6})/gi,
	]

	for (const pattern of preferredPatterns) {
		for (const match of text.matchAll(pattern)) {
			if (match[1]) {
				orderedCandidates.push(match[1])
			}
		}
	}

	for (const match of text.matchAll(/\b(\d{6})\b/g)) {
		if (match[1]) {
			orderedCandidates.push(match[1])
		}
	}

	return [...new Set(orderedCandidates)]
}

function escapeGmailQueryValue(value: string): string {
	return value.replaceAll('"', String.raw`\"`)
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
