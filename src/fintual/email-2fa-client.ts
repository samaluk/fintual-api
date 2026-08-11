import { Effect, Predicate, Schema } from "effect"
import { ImapFlow, type SearchObject } from "imapflow"
import type { Email2FAConfig } from "../env.ts"
import { getErrorMessage, revealSecret, toError } from "../log.ts"

export interface ImapMailboxLock {
  release(): void
}

export interface ImapMessage {
  source?: Buffer
  envelope?: { subject?: string }
  internalDate?: Date | string
}

export interface ImapClient {
  readonly usable: boolean
  connect(): Effect.Effect<void, Error>
  getMailboxLock(path: string): Effect.Effect<ImapMailboxLock, Error | MissingMailbox>
  search(query: SearchObject): Effect.Effect<number[] | false, Error | MissingServerExtension>
  fetchOne(uid: number): Effect.Effect<ImapMessage | null, Error>
  logout(): Effect.Effect<void, Error>
}

export class MissingServerExtension extends Schema.TaggedError<MissingServerExtension>()(
  "MissingServerExtension",
  {
    cause: Schema.Defect(),
  },
) {
  get message(): string {
    return getErrorMessage(this.cause)
  }
}

export class MissingMailbox extends Schema.TaggedError<MissingMailbox>()("MissingMailbox", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ImapFlowClient implements ImapClient {
  private readonly raw: ImapFlow

  constructor(raw: ImapFlow) {
    this.raw = raw
  }

  get usable(): boolean {
    return this.raw.usable
  }

  readonly connect = Effect.fn("Email2FA.ImapFlowClient.connect")(
    { self: this },
    function* (this: ImapFlowClient): Effect.fn.Return<void, Error> {
      yield* Effect.tryPromise({
        try: () => this.raw.connect(),
        catch: (error) => toError(error, "Failed to connect to Gmail IMAP"),
      })
    },
  )

  readonly getMailboxLock = Effect.fn("Email2FA.ImapFlowClient.getMailboxLock")(
    { self: this },
    function* (
      this: ImapFlowClient,
      path: string,
    ): Effect.fn.Return<ImapMailboxLock, Error | MissingMailbox> {
      return yield* Effect.tryPromise({
        try: () => this.raw.getMailboxLock(path),
        catch: (cause) =>
          Predicate.isObject(cause) && cause.mailboxMissing === true
            ? new MissingMailbox({ path, cause })
            : new Error(`Failed to lock Gmail IMAP mailbox ${path}: ${getErrorMessage(cause)}`, {
                cause,
              }),
      })
    },
  )

  readonly search = Effect.fn("Email2FA.ImapFlowClient.search")(
    { self: this },
    function* (
      this: ImapFlowClient,
      query: SearchObject,
    ): Effect.fn.Return<number[] | false, Error | MissingServerExtension> {
      return yield* Effect.tryPromise({
        try: () => this.raw.search(query, { uid: true }),
        catch: (cause) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          const originalError = cause as { code?: string } | undefined
          if (originalError?.code === "MissingServerExtension") {
            return new MissingServerExtension({ cause })
          }
          return new Error(`Failed to search Gmail IMAP mailbox: ${getErrorMessage(cause)}`, {
            cause,
          })
        },
      })
    },
  )

  readonly fetchOne = Effect.fn("Email2FA.ImapFlowClient.fetchOne")(
    { self: this },
    function* (this: ImapFlowClient, uid: number): Effect.fn.Return<ImapMessage | null, Error> {
      return yield* Effect.map(
        Effect.tryPromise({
          try: () =>
            this.raw.fetchOne(
              String(uid),
              { source: true, envelope: true, internalDate: true },
              { uid: true },
            ),
          catch: (error) => toError(error, "Failed to fetch Gmail IMAP message"),
        }),
        (message) =>
          message
            ? {
                source: message.source,
                envelope: message.envelope ? { subject: message.envelope.subject } : undefined,
                internalDate: message.internalDate,
              }
            : null,
      )
    },
  )

  readonly logout = Effect.fn("Email2FA.ImapFlowClient.logout")(
    { self: this },
    function* (this: ImapFlowClient): Effect.fn.Return<void, Error> {
      yield* Effect.tryPromise({
        try: () => this.raw.logout(),
        catch: (error) => toError(error, "Failed to close IMAP connection cleanly"),
      })
    },
  )
}

export function createImapClient(config: Email2FAConfig): ImapClient {
  return new ImapFlowClient(
    new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      auth: {
        user: config.userEmail,
        pass: revealSecret(config.appPassword),
      },
      logger: false,
    }),
  )
}
