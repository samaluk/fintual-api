import { Effect } from "effect"
import { ImapFlow, type SearchObject } from "imapflow"
import { simpleParser } from "mailparser"
import { error, log, sleep, tryPromise, warn } from "../effect.ts"
import { getEnv } from "../env.ts"
import { getErrorMessage } from "../log.ts"

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_RESULTS = 10

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

export function get2FACodeFromEmail(options: Email2FAOptions): Effect.Effect<string | null, Error> {
  const {
    afterTimestamp,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options

  if (!GMAIL_USER_EMAIL || !GMAIL_APP_PASSWORD) {
    return Effect.as(
      log("Gmail IMAP credentials not configured, skipping automatic 2FA retrieval"),
      null,
    )
  }

  return Effect.gen(function* () {
    yield* log("Connecting to Gmail IMAP for automatic 2FA retrieval...")
    const imapClient = createImapClient()
    const startedAt = Date.now()
    const seenMessageKeys = new Set<string>()

    const program = Effect.gen(function* () {
      yield* tryPromise({
        try: () => imapClient.connect(),
        catch: "Failed to connect to Gmail IMAP",
      })

      while (Date.now() - startedAt < timeoutMs) {
        const code = yield* searchForCode(imapClient, afterTimestamp, seenMessageKeys)
        if (code) {
          yield* log("2FA code retrieved from Gmail.")
          return code
        }

        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
        yield* log(`Waiting for 2FA email... (${elapsedSeconds}s elapsed)`)
        yield* sleep(pollIntervalMs)
      }

      yield* log("Timeout waiting for 2FA email")
      return null
    })

    return yield* Effect.catchAll(Effect.ensuring(program, closeImapClient(imapClient)), (cause) =>
      Effect.as(error(`Error fetching 2FA code from Gmail IMAP: ${getErrorMessage(cause)}`), null),
    )
  })
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

function searchForCode(
  imapClient: ImapFlow,
  afterTimestamp: Date,
  seenMessageKeys: Set<string>,
): Effect.Effect<string | null, Error> {
  const paths = imapSearchMailboxes()

  return Effect.gen(function* () {
    for (const mailboxPath of paths) {
      const lock = yield* Effect.catchAll(
        tryPromise({
          try: () => imapClient.getMailboxLock(mailboxPath),
          catch: `Failed to lock Gmail IMAP mailbox ${mailboxPath}`,
        }),
        () =>
          GMAIL_IMAP_DEBUG
            ? Effect.as(log(`Gmail IMAP: skip missing mailbox ${mailboxPath}`), undefined)
            : Effect.succeed(undefined),
      )
      if (!lock) {
        continue
      }

      const code = yield* Effect.ensuring(
        Effect.gen(function* () {
          const messageUids = yield* runMailboxSearch(imapClient, afterTimestamp)
          if (GMAIL_IMAP_DEBUG) {
            yield* log(
              `Gmail IMAP: ${mailboxPath} search -> ${messageUids === false ? "no match" : `${messageUids.length} uid(s)`}`,
            )
          }
          if (!messageUids) {
            return null
          }

          return yield* extractCodeFromMailboxUids(
            imapClient,
            mailboxPath,
            messageUids,
            afterTimestamp,
            seenMessageKeys,
          )
        }),
        Effect.sync(() => lock.release()),
      )
      if (code) {
        return code
      }
    }

    return null
  })
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

function extractCodeFromMailboxUids(
  imapClient: ImapFlow,
  mailboxPath: string,
  messageUids: number[],
  afterTimestamp: Date,
  seenMessageKeys: Set<string>,
): Effect.Effect<string | null, Error> {
  const recentUids = messageUids.slice(-MAX_RESULTS).reverse()

  return Effect.gen(function* () {
    for (const uid of recentUids) {
      const key = messageSeenKey(mailboxPath, uid)
      if (seenMessageKeys.has(key)) {
        continue
      }
      seenMessageKeys.add(key)

      const message = yield* tryPromise({
        try: () =>
          imapClient.fetchOne(
            String(uid),
            {
              source: true,
              envelope: true,
              internalDate: true,
            },
            { uid: true },
          ),
        catch: "Failed to fetch Gmail IMAP message",
      })
      if (!message || !message.source) {
        continue
      }

      const internalDate =
        typeof message.internalDate === "string"
          ? new Date(message.internalDate)
          : message.internalDate
      const deliveredAt = internalDate?.getTime() ?? 0
      if (deliveredAt > 0 && deliveredAt < afterTimestamp.getTime()) {
        continue
      }

      const code = yield* extractCodeFromMessage(message.source, message.envelope?.subject ?? "")
      if (code) {
        return code
      }
    }

    return null
  })
}

function runMailboxSearch(
  imapClient: ImapFlow,
  afterTimestamp: Date,
): Effect.Effect<number[] | false, Error> {
  const queries = buildSearchQueries(afterTimestamp)

  return Effect.gen(function* () {
    for (const query of queries) {
      const messageUids = yield* Effect.catchAll(
        tryPromise({
          try: () => imapClient.search(query, { uid: true }),
          catch: "Failed to search Gmail IMAP mailbox",
        }),
        (cause) => {
          const originalError = cause.cause as { code?: string } | undefined
          if (originalError?.code === "MissingServerExtension") {
            return Effect.succeed(false as const)
          }
          return Effect.fail(cause)
        },
      )
      if (messageUids && messageUids.length > 0) {
        return messageUids
      }
    }

    return false
  })
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

function closeImapClient(imapClient: ImapFlow): Effect.Effect<void> {
  if (!imapClient.usable) {
    return Effect.void
  }

  return Effect.catchAll(
    tryPromise({
      try: () => imapClient.logout(),
      catch: "Failed to close IMAP connection cleanly",
    }),
    (cause) => warn(`Failed to close IMAP connection cleanly: ${getErrorMessage(cause)}`),
  )
}

function extractCodeFromMessage(
  rawSource: Buffer | Uint8Array,
  envelopeSubject: string,
): Effect.Effect<string | null, Error> {
  return Effect.gen(function* () {
    const sources = yield* collectMessageSources(rawSource, envelopeSubject)

    for (const source of sources) {
      const code = extractCodeFromText(source)
      if (code) {
        return code
      }
    }

    return null
  })
}

function collectMessageSources(
  rawSource: Buffer | Uint8Array,
  envelopeSubject: string,
): Effect.Effect<string[], Error> {
  return Effect.gen(function* () {
    const sources: string[] = []
    if (envelopeSubject) {
      sources.push(envelopeSubject)
    }

    const parsedMessage = yield* tryPromise({
      try: () => simpleParser(Buffer.from(rawSource)),
      catch: "Failed to parse Gmail IMAP message",
    })
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
  })
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
