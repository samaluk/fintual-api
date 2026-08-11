import { Effect, Schema } from "effect"
import { ImapFlow, type SearchObject } from "imapflow"
import { tryPromise } from "../effect.ts"
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
  connect(): Effect.Effect<void, Error>
  getMailboxLock(path: string): Effect.Effect<ImapMailboxLock, Error>
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

export class ImapFlowClient implements ImapClient {
  private readonly raw: ImapFlow

  constructor(raw: ImapFlow) {
    this.raw = raw
  }

  get usable(): boolean {
    return this.raw.usable
  }

  connect(): Effect.Effect<void, Error> {
    return tryPromise({
      try: () => this.raw.connect(),
      catch: "Failed to connect to Gmail IMAP",
    })
  }

  getMailboxLock(path: string): Effect.Effect<ImapMailboxLock, Error> {
    return tryPromise({
      try: () => this.raw.getMailboxLock(path),
      catch: `Failed to lock Gmail IMAP mailbox ${path}`,
    })
  }

  search(query: SearchObject): Effect.Effect<number[] | false, Error | MissingServerExtension> {
    return Effect.tryPromise({
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
  }

  fetchOne(uid: number): Effect.Effect<ImapMessage | null, Error> {
    return Effect.map(
      tryPromise({
        try: () =>
          this.raw.fetchOne(
            String(uid),
            { source: true, envelope: true, internalDate: true },
            { uid: true },
          ),
        catch: "Failed to fetch Gmail IMAP message",
      }),
      (message) =>
        message
          ? {
              source: message.source,
              envelope: message.envelope,
              internalDate: message.internalDate,
            }
          : null,
    )
  }

  logout(): Effect.Effect<void, Error> {
    return tryPromise({
      try: () => this.raw.logout(),
      catch: "Failed to close IMAP connection cleanly",
    })
  }
}

export function createImapClient(config: Email2FAConfig): ImapClient {
  return new ImapFlowClient(
    new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      auth: {
        user: config.userEmail,
        pass: config.appPassword,
      },
      logger: false,
    }),
  )
}
