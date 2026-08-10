import { Effect } from "effect"
import { ImapFlow, type SearchObject } from "imapflow"
import { simpleParser } from "mailparser"
import { error, log, sleep, tryPromise, warn } from "../effect.ts"
import type { Email2FAConfig } from "../env.ts"
import { getErrorMessage } from "../log.ts"

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_RESULTS = 10

/** Gmail can file 2FA under categories; IMAP search is per-folder. */
const GMAIL_IMAP_SEARCH_PATHS = ["INBOX", "[Gmail]/All Mail", "[Gmail]/Spam"] as const

export interface Email2FAOptions {
  afterTimestamp: Date
  timeoutMs?: number
  pollIntervalMs?: number
}

export function get2FACodeFromEmail(
  config: Email2FAConfig | null,
  options: Email2FAOptions,
): Effect.Effect<string | null, Error> {
  const {
    afterTimestamp,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options

  if (!config) {
    return Effect.as(
      log("Gmail IMAP credentials not configured, skipping automatic 2FA retrieval"),
      null,
    )
  }

  return Effect.gen(function* () {
    yield* log("Connecting to Gmail IMAP for automatic 2FA retrieval...")
    const imapClient = createImapClient(config)
    const startedAt = Date.now()
    const seenMessageKeys = new Set<string>()

    const program = Effect.gen(function* () {
      yield* tryPromise({
        try: () => imapClient.connect(),
        catch: "Failed to connect to Gmail IMAP",
      })

      while (Date.now() - startedAt < timeoutMs) {
        const code = yield* searchForCode(config, imapClient, afterTimestamp, seenMessageKeys)
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

function createImapClient(config: Email2FAConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: {
      user: config.userEmail,
      pass: config.appPassword,
    },
    logger: false,
  })
}

function searchForCode(
  config: Email2FAConfig,
  imapClient: ImapFlow,
  afterTimestamp: Date,
  seenMessageKeys: Set<string>,
): Effect.Effect<string | null, Error> {
  const paths = imapSearchMailboxes(config)

  return Effect.gen(function* () {
    for (const mailboxPath of paths) {
      const lock = yield* Effect.catchAll(
        tryPromise({
          try: () => imapClient.getMailboxLock(mailboxPath),
          catch: `Failed to lock Gmail IMAP mailbox ${mailboxPath}`,
        }),
        () =>
          config.debug
            ? Effect.as(log(`Gmail IMAP: skip missing mailbox ${mailboxPath}`), undefined)
            : Effect.succeed(undefined),
      )
      if (!lock) {
        continue
      }

      const code = yield* Effect.ensuring(
        Effect.gen(function* () {
          const messageUids = yield* runMailboxSearch(config, imapClient, afterTimestamp)
          if (config.debug) {
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

function imapSearchMailboxes(config: Email2FAConfig): string[] {
  if (isGmailImapHost(config.host)) {
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
  config: Email2FAConfig,
  imapClient: ImapFlow,
  afterTimestamp: Date,
): Effect.Effect<number[] | false, Error> {
  const queries = buildSearchQueries(config, afterTimestamp)

  return Effect.gen(function* () {
    for (const query of queries) {
      const messageUids = yield* Effect.catchAll(
        tryPromise({
          try: () => imapClient.search(query, { uid: true }),
          catch: "Failed to search Gmail IMAP mailbox",
        }),
        (cause) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
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

function buildSearchQueries(config: Email2FAConfig, afterTimestamp: Date): SearchObject[] {
  const queries: SearchObject[] = []

  if (isGmailImapHost(config.host)) {
    const after = formatGmailAfterDate(afterTimestamp)
    queries.push({
      gmraw: `from:${config.sender} after:${after}`,
    })
    queries.push({
      gmraw: `from:fintual.com after:${after}`,
    })
    // Relative window avoids rare date/TZ mismatches between container and Gmail account settings.
    queries.push({
      gmraw: `from:${config.sender} newer_than:1d`,
    })
    queries.push({
      gmraw: `from:fintual.com newer_than:1d`,
    })
  }

  queries.push({
    from: config.sender,
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
  return (
    value
      .replaceAll(/=\r?\n/g, "")
      // oxlint-disable-next-line typescript/no-unsafe-argument
      .replaceAll(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
  )
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
