import { Clock, Context, Effect, Layer } from "effect"
import { error, log, sleep, warn } from "../effect.ts"
import { FintualConfigService, type Email2FAConfig } from "../env.ts"
import { getErrorMessage } from "../log.ts"
import { createImapClient, MissingServerExtension, type ImapClient } from "./email-2fa-client.ts"
import { Email2FAFailure } from "./fintual-error.ts"
import {
  buildEmail2FASearchQueries,
  isGmailImapHost,
  selectEmail2FACode,
  type Email2FACandidate,
} from "./email-2fa-policy.ts"

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_RESULTS = 10

/** Gmail can file 2FA under categories; IMAP search is per-folder. */
const GMAIL_IMAP_SEARCH_PATHS = ["INBOX", "[Gmail]/All Mail", "[Gmail]/Spam"] as const

export class Email2FAService extends Context.Service<
  Email2FAService,
  {
    get2FACode: (options: Email2FAOptions) => Effect.Effect<string | null, Email2FAFailure>
  }
>()("Email2FAService") {
  static readonly layer = Layer.effect(
    Email2FAService,
    Effect.gen(function* () {
      const config = yield* FintualConfigService

      return Email2FAService.of({
        get2FACode: Effect.fn("Email2FAService.get2FACode")(function* (options) {
          return yield* get2FACodeFromEmail(config.email2FA, options).pipe(
            Effect.mapError((cause) => new Email2FAFailure({ cause })),
          )
        }),
      })
    }),
  )
}

interface Email2FAOptions {
  afterTimestamp: Date
  timeoutMs?: number
  pollIntervalMs?: number
}

function get2FACodeFromEmail(
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
    const startedAt = yield* Clock.currentTimeMillis
    const seenMessageKeys = new Set<string>()

    const program = Effect.gen(function* () {
      yield* imapClient.connect()

      while ((yield* Clock.currentTimeMillis) - startedAt < timeoutMs) {
        const code = yield* searchForCode(config, imapClient, afterTimestamp, seenMessageKeys)
        if (code) {
          yield* log("2FA code retrieved from Gmail.")
          return code
        }

        const now = yield* Clock.currentTimeMillis
        const elapsedSeconds = Math.round((now - startedAt) / 1000)
        yield* log(`Waiting for 2FA email... (${elapsedSeconds}s elapsed)`)
        yield* sleep(pollIntervalMs)
      }

      yield* log("Timeout waiting for 2FA email")
      return null
    })

    return yield* Effect.tapError(Effect.ensuring(program, closeImapClient(imapClient)), (cause) =>
      error(`Error fetching 2FA code from Gmail IMAP: ${getErrorMessage(cause)}`),
    )
  })
}

function searchForCode(
  config: Email2FAConfig,
  imapClient: ImapClient,
  afterTimestamp: Date,
  seenMessageKeys: Set<string>,
): Effect.Effect<string | null, Error> {
  const paths = imapSearchMailboxes(config)

  return Effect.gen(function* () {
    for (const mailboxPath of paths) {
      const lock = yield* Effect.catch(imapClient.getMailboxLock(mailboxPath), () =>
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
  imapClient: ImapClient,
  mailboxPath: string,
  messageUids: number[],
  afterTimestamp: Date,
  seenMessageKeys: Set<string>,
): Effect.Effect<string | null, Error> {
  const recentUids = messageUids.slice(-MAX_RESULTS).reverse()

  return Effect.gen(function* () {
    const candidates: Email2FACandidate[] = []
    for (const uid of recentUids) {
      const key = messageSeenKey(mailboxPath, uid)
      if (seenMessageKeys.has(key)) {
        continue
      }
      seenMessageKeys.add(key)

      const message = yield* imapClient.fetchOne(uid)
      if (!message || !message.source) {
        continue
      }

      const internalDate =
        typeof message.internalDate === "string"
          ? new Date(message.internalDate)
          : message.internalDate
      candidates.push({
        source: message.source,
        envelopeSubject: message.envelope?.subject,
        receivedAt: internalDate,
      })
    }

    return yield* selectEmail2FACode(candidates, afterTimestamp)
  })
}

function runMailboxSearch(
  config: Email2FAConfig,
  imapClient: ImapClient,
  afterTimestamp: Date,
): Effect.Effect<number[] | false, Error> {
  const queries = buildEmail2FASearchQueries(config, afterTimestamp)

  return Effect.gen(function* () {
    for (const query of queries) {
      const messageUids = yield* Effect.catchIf(
        imapClient.search(query),
        (cause): cause is MissingServerExtension => cause instanceof MissingServerExtension,
        () => Effect.succeed(false as const),
      )
      if (messageUids && messageUids.length > 0) {
        return messageUids
      }
    }

    return false
  })
}

function closeImapClient(imapClient: ImapClient): Effect.Effect<void> {
  if (!imapClient.usable) {
    return Effect.void
  }

  return Effect.catch(imapClient.logout(), (cause) =>
    warn(`Failed to close IMAP connection cleanly: ${getErrorMessage(cause)}`),
  )
}
