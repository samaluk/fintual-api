import { Clock, Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import type { Email2FAConfig } from "../../env.ts"
import { getErrorMessage } from "../../log.ts"
import { createImapClient, MissingServerExtension, type ImapClient } from "../email-2fa-client.ts"
import {
  buildEmail2FASearchQueries,
  isGmailImapHost,
  selectEmail2FACode,
  type Email2FACandidate,
} from "./email-2fa-policy.ts"

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 2_000
const MAX_RESULTS = 10

/** Gmail can file 2FA under categories; IMAP search is per-folder. */
const GMAIL_IMAP_SEARCH_PATHS = ["INBOX", "[Gmail]/All Mail", "[Gmail]/Spam"] as const

const Email2FACodeSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{6}$/)),
  Schema.brand("Email2FACode"),
)

export type Email2FACode = typeof Email2FACodeSchema.Type

export const Email2FACode = {
  make: (value: string): Email2FACode => Email2FACodeSchema.make(value),
}

export class TimedOut extends Schema.TaggedError<TimedOut>()("TimedOut", {}) {}

export class Operational extends Schema.TaggedError<Operational>()("Operational", {
  cause: Schema.Defect(),
}) {
  get message(): string {
    return getErrorMessage(this.cause)
  }
}

export interface Email2FAOptions {
  afterTimestamp: Date
  timeoutMs?: number
  pollIntervalMs?: number
}

export class ImapClientFactory extends Context.Service<
  ImapClientFactory,
  {
    readonly create: (config: Email2FAConfig) => ImapClient
  }
>()("Email2FA/ImapClientFactory") {}

export const ImapClientFactoryLive = Layer.succeed(ImapClientFactory, {
  create: createImapClient,
})

const toOperational = (cause: unknown): Operational => new Operational({ cause })

export function retrieveEmail2FACode(
  config: Email2FAConfig,
  options: Email2FAOptions,
): Effect.Effect<Email2FACode, TimedOut | Operational, ImapClientFactory> {
  const {
    afterTimestamp,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options

  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.logInfo("Connecting to Gmail IMAP for automatic 2FA retrieval...")
      const clientFactory = yield* ImapClientFactory

      const imapClient = yield* Effect.acquireRelease(
        connectImapClient(clientFactory, config),
        closeImapClient,
      ).pipe(Effect.mapError(toOperational))

      const startedAt = yield* Clock.currentTimeMillis
      const seenMessageKeys = new Set<string>()

      const poll = pollForCode(config, imapClient, afterTimestamp, seenMessageKeys).pipe(
        Effect.tap((outcome) => (Option.isSome(outcome) ? Effect.void : logPollWait(startedAt))),
      )

      const outcome = yield* poll.pipe(
        Effect.repeat({
          schedule: Schedule.spaced(pollIntervalMs),
          until: Option.isSome,
        }),
        Effect.timeoutOption(timeoutMs),
        Effect.mapError(toOperational),
      )
      const code = Option.flatten(outcome)

      if (Option.isSome(code)) {
        yield* Effect.logInfo("2FA code retrieved from Gmail.")
        return code.value
      }

      yield* Effect.logWarning("Timeout waiting for 2FA email")
      return yield* new TimedOut()
    }),
  ).pipe(
    Effect.tapError((cause) =>
      cause instanceof Operational
        ? Effect.logError(`Error fetching 2FA code from Gmail IMAP: ${getErrorMessage(cause)}`)
        : Effect.void,
    ),
  )
}

function connectImapClient(
  clientFactory: ImapClientFactory["Service"],
  config: Email2FAConfig,
): Effect.Effect<ImapClient, Error> {
  return Effect.gen(function* () {
    const imapClient = clientFactory.create(config)
    yield* imapClient.connect()
    return imapClient
  })
}

function closeImapClient(imapClient: ImapClient): Effect.Effect<void, never> {
  if (!imapClient.usable) {
    return Effect.void
  }

  return Effect.catch(imapClient.logout(), (cause) =>
    Effect.logWarning(`Failed to close IMAP connection cleanly: ${getErrorMessage(cause)}`),
  )
}

function logPollWait(startedAt: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const elapsedSeconds = Math.round((now - startedAt) / 1000)
    yield* Effect.logDebug(`Waiting for 2FA email... (${elapsedSeconds}s elapsed)`)
  })
}

function pollForCode(
  config: Email2FAConfig,
  imapClient: ImapClient,
  afterTimestamp: Date,
  seenMessageKeys: Set<string>,
): Effect.Effect<Option.Option<Email2FACode>, Error> {
  return Effect.gen(function* () {
    for (const mailboxPath of imapSearchMailboxes(config)) {
      const code = yield* searchMailbox(
        config,
        imapClient,
        mailboxPath,
        afterTimestamp,
        seenMessageKeys,
      )
      if (Option.isSome(code)) {
        return code
      }
    }

    return Option.none()
  })
}

function imapSearchMailboxes(config: Email2FAConfig): string[] {
  if (isGmailImapHost(config.host)) {
    return [...GMAIL_IMAP_SEARCH_PATHS]
  }
  return ["INBOX"]
}

function searchMailbox(
  config: Email2FAConfig,
  imapClient: ImapClient,
  mailboxPath: string,
  afterTimestamp: Date,
  seenMessageKeys: Set<string>,
): Effect.Effect<Option.Option<Email2FACode>, Error> {
  return Effect.gen(function* () {
    const lock = yield* Effect.catch(imapClient.getMailboxLock(mailboxPath), () =>
      config.debug
        ? Effect.as(Effect.log(`Gmail IMAP: skip missing mailbox ${mailboxPath}`), undefined)
        : Effect.succeed(undefined),
    )
    if (!lock) {
      return Option.none()
    }

    return yield* Effect.ensuring(
      searchLockedMailbox(config, imapClient, mailboxPath, afterTimestamp, seenMessageKeys),
      Effect.sync(() => lock.release()),
    )
  })
}

function searchLockedMailbox(
  config: Email2FAConfig,
  imapClient: ImapClient,
  mailboxPath: string,
  afterTimestamp: Date,
  seenMessageKeys: Set<string>,
): Effect.Effect<Option.Option<Email2FACode>, Error> {
  return Effect.gen(function* () {
    const messageUids = yield* runMailboxSearch(config, imapClient, afterTimestamp)
    if (config.debug) {
      yield* Effect.log(
        `Gmail IMAP: ${mailboxPath} search -> ${messageUids === false ? "no match" : `${messageUids.length} uid(s)`}`,
      )
    }
    if (!messageUids) {
      return Option.none()
    }

    return yield* extractCodeFromMailboxUids(
      imapClient,
      mailboxPath,
      messageUids,
      afterTimestamp,
      seenMessageKeys,
    )
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

function extractCodeFromMailboxUids(
  imapClient: ImapClient,
  mailboxPath: string,
  messageUids: number[],
  afterTimestamp: Date,
  seenMessageKeys: Set<string>,
): Effect.Effect<Option.Option<Email2FACode>, Error> {
  const recentUids = messageUids.slice(-MAX_RESULTS).reverse()

  return Effect.gen(function* () {
    const candidates: Email2FACandidate[] = []
    for (const uid of recentUids) {
      const key = messageSeenKey(mailboxPath, uid)
      if (seenMessageKeys.has(key)) {
        continue
      }
      seenMessageKeys.add(key)

      const message = yield* Effect.catch(imapClient.fetchOne(uid), () => Effect.succeed(null))
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

    return yield* selectEmail2FACode(candidates, afterTimestamp).pipe(
      Effect.map((code) => (code ? Option.some(Email2FACode.make(code)) : Option.none())),
    )
  })
}

function messageSeenKey(mailboxPath: string, uid: number): string {
  return `${mailboxPath}:${uid}`
}
