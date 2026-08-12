import { Context, Effect, Layer, Predicate, Redacted, Schema } from "effect"
import { ImapFlow, type SearchObject } from "imapflow"
import type { Email2FAConfig } from "../env.ts"
import { getErrorMessage } from "../log.ts"

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
  connect(): Effect.Effect<void, ImapOperationFailure>
  getMailboxLock(
    path: string,
  ): Effect.Effect<ImapMailboxLock, ImapMailboxLockFailure | MissingMailbox>
  search(
    query: SearchObject,
  ): Effect.Effect<number[] | false, ImapOperationFailure | MissingServerExtension>
  fetchOne(uid: number): Effect.Effect<ImapMessage | null, ImapOperationFailure>
  logout(): Effect.Effect<void, ImapOperationFailure>
}

export class MissingServerExtension extends Schema.TaggedError<MissingServerExtension>()(
  "MissingServerExtension",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return getErrorMessage(this.cause)
  }
}

export class MissingMailbox extends Schema.TaggedError<MissingMailbox>()("MissingMailbox", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ImapOperationFailure extends Schema.TaggedError<ImapOperationFailure>()(
  "ImapOperationFailure",
  {
    stage: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.stage}: ${getErrorMessage(this.cause)}`
  }
}

export class ImapMailboxLockFailure extends Schema.TaggedError<ImapMailboxLockFailure>()(
  "ImapMailboxLockFailure",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to lock Gmail IMAP mailbox ${this.path}: ${getErrorMessage(this.cause)}`
  }
}

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
    function* (this: ImapFlowClient): Effect.fn.Return<void, ImapOperationFailure> {
      yield* Effect.tryPromise({
        try: () => this.raw.connect(),
        catch: (cause) =>
          new ImapOperationFailure({ stage: "Failed to connect to Gmail IMAP", cause }),
      })
    },
  )

  readonly getMailboxLock = Effect.fn("Email2FA.ImapFlowClient.getMailboxLock")(
    { self: this },
    function* (
      this: ImapFlowClient,
      path: string,
    ): Effect.fn.Return<ImapMailboxLock, ImapMailboxLockFailure | MissingMailbox> {
      return yield* Effect.tryPromise({
        try: () => this.raw.getMailboxLock(path),
        catch: (cause) =>
          Predicate.isObject(cause) && cause.mailboxMissing === true
            ? new MissingMailbox({ path, cause })
            : new ImapMailboxLockFailure({ path, cause }),
      })
    },
  )

  readonly search = Effect.fn("Email2FA.ImapFlowClient.search")(
    { self: this },
    function* (
      this: ImapFlowClient,
      query: SearchObject,
    ): Effect.fn.Return<number[] | false, ImapOperationFailure | MissingServerExtension> {
      return yield* Effect.tryPromise({
        try: () => this.raw.search(query, { uid: true }),
        catch: (cause) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          const originalError = cause as { code?: string } | undefined
          if (originalError?.code === "MissingServerExtension") {
            return new MissingServerExtension({ cause })
          }
          return new ImapOperationFailure({
            stage: "Failed to search Gmail IMAP mailbox",
            cause,
          })
        },
      })
    },
  )

  readonly fetchOne = Effect.fn("Email2FA.ImapFlowClient.fetchOne")(
    { self: this },
    function* (
      this: ImapFlowClient,
      uid: number,
    ): Effect.fn.Return<ImapMessage | null, ImapOperationFailure> {
      return yield* Effect.map(
        Effect.tryPromise({
          try: () =>
            this.raw.fetchOne(
              String(uid),
              { source: true, envelope: true, internalDate: true },
              { uid: true },
            ),
          catch: (cause) =>
            new ImapOperationFailure({
              stage: "Failed to fetch Gmail IMAP message",
              cause,
            }),
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
    function* (this: ImapFlowClient): Effect.fn.Return<void, ImapOperationFailure> {
      yield* Effect.tryPromise({
        try: () => this.raw.logout(),
        catch: (cause) =>
          new ImapOperationFailure({
            stage: "Failed to close IMAP connection cleanly",
            cause,
          }),
      })
    },
  )
}

function createImapClient(config: Email2FAConfig): ImapClient {
  return new ImapFlowClient(
    new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      auth: {
        user: config.userEmail,
        pass: Redacted.value(config.appPassword),
      },
      logger: false,
    }),
  )
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
