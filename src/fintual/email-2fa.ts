import { ImapFlow, type SearchObject } from "imapflow"
import { simpleParser } from "mailparser"
import { getEnv } from "../env.ts"
import { getErrorMessage } from "../log.ts"

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_RESULTS = 10
/** Ignore INTERNALDATE vs local clock skew (same problem as Docker VM drift). */
const DELIVERED_AT_SKEW_BUFFER_MS = 5 * 60 * 1000

const GMAIL_IMAP_HOST = getEnv("GMAIL_IMAP_HOST", "imap.gmail.com")
const GMAIL_IMAP_PORT = Number.parseInt(getEnv("GMAIL_IMAP_PORT", "993"), 10)
const GMAIL_IMAP_DEBUG = ["1", "true"].includes(getEnv("GMAIL_IMAP_DEBUG", "").toLowerCase())
const GMAIL_USER_EMAIL = getEnv("GMAIL_USER_EMAIL")
const GMAIL_APP_PASSWORD = getEnv("GMAIL_APP_PASSWORD")
const FINTUAL_2FA_SENDER = getEnv("FINTUAL_2FA_SENDER", "notificaciones@fintual.com")

/** Gmail can file 2FA under categories; IMAP search is per-folder. */
const GMAIL_IMAP_SEARCH_PATHS = ["INBOX", "[Gmail]/All Mail", "[Gmail]/Spam"] as const

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
	const seenMessageKeys = new Set<string>()

	try {
		await imapClient.connect()

		while (Date.now() - startedAt < timeoutMs) {
			const code = await searchForCode(imapClient, afterTimestamp, seenMessageKeys)
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
	seenMessageKeys: Set<string>,
): Promise<string | null> {
	const paths = imapSearchMailboxes()

	for (const mailboxPath of paths) {
		let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | undefined
		try {
			lock = await imapClient.getMailboxLock(mailboxPath)
		} catch {
			if (GMAIL_IMAP_DEBUG) {
				console.log(`Gmail IMAP: skip missing mailbox ${mailboxPath}`)
			}
			continue
		}

		try {
			const messageUids = await runMailboxSearch(imapClient, afterTimestamp)
			if (GMAIL_IMAP_DEBUG) {
				console.log(
					`Gmail IMAP: ${mailboxPath} search → ${messageUids === false ? "no match" : `${messageUids.length} uid(s)`}`,
				)
			}
			if (!messageUids) {
				continue
			}

			const code = await extractCodeFromMailboxUids(
				imapClient,
				mailboxPath,
				messageUids,
				afterTimestamp,
				seenMessageKeys,
			)
			if (code) {
				return code
			}
		} finally {
			lock?.release()
		}
	}

	return null
}

function imapSearchMailboxes(): string[] {
	if (isGmailImapHost(GMAIL_IMAP_HOST)) {
		return [...GMAIL_IMAP_SEARCH_PATHS]
	}
	return ["INBOX"]
}

function messageSeenKey(mailboxPath: string, uid: number): string {
	return `${mailboxPath}:${uid}`
}

async function extractCodeFromMailboxUids(
	imapClient: ImapFlow,
	mailboxPath: string,
	messageUids: number[],
	afterTimestamp: Date,
	seenMessageKeys: Set<string>,
): Promise<string | null> {
	const recentUids = messageUids.slice(-MAX_RESULTS).reverse()
	const earliestDeliveredAt = afterTimestamp.getTime() - DELIVERED_AT_SKEW_BUFFER_MS

	for (const uid of recentUids) {
		const key = messageSeenKey(mailboxPath, uid)
		if (seenMessageKeys.has(key)) {
			continue
		}
		seenMessageKeys.add(key)

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
		if (deliveredAt > 0 && deliveredAt < earliestDeliveredAt) {
			continue
		}

		const code = await extractCodeFromMessage(message.source, message.envelope?.subject ?? "")
		if (code) {
			return code
		}
	}

	return null
}

async function runMailboxSearch(imapClient: ImapFlow, afterTimestamp: Date): Promise<number[] | false> {
	const queries = buildSearchQueries(afterTimestamp)

	for (const query of queries) {
		try {
			const messageUids = await imapClient.search(query, { uid: true })
			if (messageUids && messageUids.length > 0) {
				return messageUids
			}
		} catch (error) {
			const err = error as { code?: string }
			if (err.code === "MissingServerExtension") {
				continue
			}
			throw error
		}
	}

	return false
}

function isGmailImapHost(host: string): boolean {
	const normalized = host.trim().toLowerCase()
	return normalized === "imap.gmail.com" || normalized === "imap.googlemail.com"
}

/** Gmail web-style search; avoids broken IMAP SUBJECT matching for UTF-8 (e.g. "Código"). */
function formatGmailAfterDate(d: Date): string {
	const yyyy = d.getFullYear()
	const mm = String(d.getMonth() + 1).padStart(2, "0")
	const dd = String(d.getDate()).padStart(2, "0")
	return `${yyyy}/${mm}/${dd}`
}

function buildSearchQueries(afterTimestamp: Date): SearchObject[] {
	const queries: SearchObject[] = []

	if (isGmailImapHost(GMAIL_IMAP_HOST)) {
		const after = formatGmailAfterDate(afterTimestamp)
		queries.push({
			gmraw: `from:${FINTUAL_2FA_SENDER} after:${after}`,
		})
		queries.push({
			gmraw: `from:fintual.com after:${after}`,
		})
		// Relative window avoids rare date/TZ mismatches between container and Gmail account settings.
		queries.push({
			gmraw: `from:${FINTUAL_2FA_SENDER} newer_than:1d`,
		})
		queries.push({
			gmraw: `from:fintual.com newer_than:1d`,
		})
	}

	queries.push({
		from: FINTUAL_2FA_SENDER,
		since: afterTimestamp,
	})

	return queries
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
