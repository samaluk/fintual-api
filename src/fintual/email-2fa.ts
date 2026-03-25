import { ImapFlow } from "imapflow"
import { simpleParser } from "mailparser"
import { getEnv } from "../env.ts"
import { getErrorMessage } from "../log.ts"

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_RESULTS = 10

const GMAIL_IMAP_HOST = getEnv("GMAIL_IMAP_HOST", "imap.gmail.com")
const GMAIL_IMAP_PORT = Number.parseInt(getEnv("GMAIL_IMAP_PORT", "993"), 10)
const GMAIL_USER_EMAIL = getEnv("GMAIL_USER_EMAIL")
const GMAIL_APP_PASSWORD = getEnv("GMAIL_APP_PASSWORD")
const FINTUAL_2FA_SENDER = getEnv("FINTUAL_2FA_SENDER", "notificaciones@fintual.com")
const FINTUAL_2FA_SUBJECT = getEnv("FINTUAL_2FA_SUBJECT", "Código para entrar")

interface Email2FAOptions {
	afterTimestamp: Date
	timeoutMs?: number
	pollIntervalMs?: number
}

export async function get2FACodeFromEmail(options: Email2FAOptions): Promise<string | null> {
	const { afterTimestamp, timeoutMs = DEFAULT_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = options

	if (!GMAIL_USER_EMAIL || !GMAIL_APP_PASSWORD) {
		console.log("Gmail IMAP credentials not configured, skipping automatic 2FA retrieval")
		return null
	}

	console.log("Connecting to Gmail IMAP for automatic 2FA retrieval...")
	const imapClient = createImapClient()
	const startedAt = Date.now()
	const seenUids = new Set<number>()

	try {
		await imapClient.connect()

		while (Date.now() - startedAt < timeoutMs) {
			const code = await searchForCode(imapClient, afterTimestamp, seenUids)
			if (code) {
				console.log("2FA code retrieved from Gmail.")
				return code
			}

			const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
			console.log(`Waiting for 2FA email... (${elapsedSeconds}s elapsed)`)
			await sleep(pollIntervalMs)
		}
	} catch (error) {
		console.error(`Error fetching 2FA code from Gmail IMAP: ${getErrorMessage(error)}`)
		return null
	} finally {
		await closeImapClient(imapClient)
	}

	console.log("Timeout waiting for 2FA email")
	return null
}

function createImapClient(): ImapFlow {
	return new ImapFlow({
		host: GMAIL_IMAP_HOST,
		port: GMAIL_IMAP_PORT,
		secure: true,
		auth: {
			user: GMAIL_USER_EMAIL,
			pass: GMAIL_APP_PASSWORD,
		},
		logger: false,
	})
}

async function searchForCode(
	imapClient: ImapFlow,
	afterTimestamp: Date,
	seenUids: Set<number>,
): Promise<string | null> {
	const lock = await imapClient.getMailboxLock("INBOX")
	try {
		const messageUids = await imapClient.search(buildSearchQuery(afterTimestamp), { uid: true })
		if (!messageUids) {
			return null
		}

		const recentUids = messageUids.slice(-MAX_RESULTS).reverse()

		for (const uid of recentUids) {
			if (seenUids.has(uid)) {
				continue
			}
			seenUids.add(uid)

			const message = await imapClient.fetchOne(
				String(uid),
				{
					source: true,
					envelope: true,
					internalDate: true,
				},
				{ uid: true },
			)
			if (!message || !message.source) {
				continue
			}

			const internalDate =
				typeof message.internalDate === "string" ? new Date(message.internalDate) : message.internalDate
			const deliveredAt = internalDate?.getTime() ?? 0
			if (deliveredAt > 0 && deliveredAt < afterTimestamp.getTime()) {
				continue
			}

			const code = await extractCodeFromMessage(message.source, message.envelope?.subject ?? "")
			if (code) {
				return code
			}
		}
	} finally {
		lock.release()
	}

	return null
}

async function closeImapClient(imapClient: ImapFlow): Promise<void> {
	if (!imapClient.usable) {
		return
	}

	try {
		await imapClient.logout()
	} catch (error) {
		console.warn(`Failed to close IMAP connection cleanly: ${getErrorMessage(error)}`)
	}
}

function buildSearchQuery(afterTimestamp: Date): Record<string, string | Date> {
	return {
		from: FINTUAL_2FA_SENDER,
		subject: FINTUAL_2FA_SUBJECT,
		since: afterTimestamp,
	}
}

async function extractCodeFromMessage(rawSource: Buffer | Uint8Array, envelopeSubject: string): Promise<string | null> {
	const sources = await collectMessageSources(rawSource, envelopeSubject)

	for (const source of sources) {
		const code = extractCodeFromText(source)
		if (code) {
			return code
		}
	}

	return null
}

async function collectMessageSources(rawSource: Buffer | Uint8Array, envelopeSubject: string): Promise<string[]> {
	const sources: string[] = []
	if (envelopeSubject) {
		sources.push(envelopeSubject)
	}

	const parsedMessage = await simpleParser(Buffer.from(rawSource))
	if (parsedMessage.subject) {
		sources.push(parsedMessage.subject)
	}
	if (parsedMessage.text) {
		sources.push(parsedMessage.text)
	}
	if (parsedMessage.html) {
		sources.push(String(parsedMessage.html))
	}

	return sources
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
