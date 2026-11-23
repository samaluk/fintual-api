import { once } from "node:events"
import { createServer } from "node:net"

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { ImapFlow } from "imapflow"
import { expect } from "vitest"

import {
  ImapFlowClient,
  ImapMailboxLockFailure,
  ImapOperationFailure,
  MissingServerExtension,
} from "./email-2fa-client.ts"

it.effect(
  "preserves a real TLS connection rejection and maps operations after vendor cleanup",
  () =>
    Effect.gen(function* () {
      const endpoint = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = createServer((socket) => socket.destroy())
          const listening = once(server, "listening")
          server.listen(0, "127.0.0.1")
          await listening
          return server
        }),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()))
              }),
          ),
      )
      const address = endpoint.address()
      if (!address || typeof address === "string") {
        throw new Error("Expected a local TCP listener")
      }
      const raw = new ImapFlow({
        host: "127.0.0.1",
        port: address.port,
        secure: true,
        auth: { user: "user@example.com", pass: "app-password" },
        logger: false,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => raw.close()))
      const closed = once(raw, "close")
      const client = new ImapFlowClient(raw)

      const connectionError = yield* Effect.flip(client.connect)

      expect(connectionError).toBeInstanceOf(ImapOperationFailure)
      expect(connectionError.stage).toBe("Failed to connect to Gmail IMAP")
      expect(connectionError.cause).toBeInstanceOf(Error)
      expect(connectionError.cause).toMatchObject({
        code: "ECONNRESET",
        host: "127.0.0.1",
        port: address.port,
      })
      if (connectionError.cause instanceof Error) {
        expect(connectionError.message).toBe(
          `Failed to connect to Gmail IMAP: ${connectionError.cause.message}`,
        )
      }

      yield* Effect.promise(() => closed)
      expect(client.usable).toBe(false)

      const lockError = yield* Effect.flip(client.getMailboxLock("INBOX"))
      expect(lockError).toBeInstanceOf(ImapMailboxLockFailure)
      expect(lockError).toMatchObject({ path: "INBOX", cause: { code: "NoConnection" } })
      expect(lockError.cause).toBeInstanceOf(Error)

      const searchResult = yield* client.search({ gmraw: "from:security@fintual.com" })
      expect(searchResult).toBe(false)

      const fetchError = yield* Effect.flip(client.fetchOne(123))
      expect(fetchError).toBeInstanceOf(ImapOperationFailure)
      expect(fetchError).toMatchObject({
        stage: "Failed to fetch Gmail IMAP message",
        cause: { code: "NoConnection" },
      })
      expect(fetchError.cause).toBeInstanceOf(Error)

      const logoutError = yield* Effect.flip(client.logout)
      expect(logoutError).toBeInstanceOf(ImapOperationFailure)
      expect(logoutError).toMatchObject({
        stage: "Failed to close IMAP connection cleanly",
        cause: { code: "NoConnection" },
      })
      expect(logoutError.cause).toBeInstanceOf(Error)
      expect(client.usable).toBe(false)
    }),
)

it.effect("surfaces a MissingServerExtension search rejection as a typed error", () =>
  Effect.gen(function* () {
    const client = clientWithSearchError(
      Object.assign(new Error("Server does not support X-GM-EXT-1 extension"), {
        code: "MissingServerExtension",
      }),
    )

    const error = yield* Effect.flip(client.search({ gmraw: "from:a" }))

    expect(error).toBeInstanceOf(MissingServerExtension)
  }),
)

it.effect("surfaces a plain search failure with the preserved message and original cause", () =>
  Effect.gen(function* () {
    const originalError = new Error("boom")
    const client = clientWithSearchError(originalError)

    const error = yield* Effect.flip(client.search({ gmraw: "from:a" }))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(MissingServerExtension)
    expect(error.message).toBe("Failed to search Gmail IMAP mailbox: boom")
    expect(error.cause).toBe(originalError)
  }),
)

it.effect("exposes only the subject from the message envelope across the seam", () =>
  Effect.gen(function* () {
    const raw = new ImapFlow({
      host: "imap.example.com",
      port: 993,
      secure: true,
      auth: { user: "user@example.com", pass: "app-password" },
      logger: false,
    })
    raw.fetchOne = async () => ({
      seq: 1,
      uid: 123,
      source: Buffer.from("Subject: Codigo 123456\n\nCodigo: 123456"),
      envelope: {
        subject: "Codigo 123456",
        date: new Date("2026-07-14T10:31:00"),
        from: [{ address: "security@fintual.com" }],
        to: [{ address: "user@example.com" }],
        messageId: "<message-id>",
      },
      internalDate: new Date("2026-07-14T10:31:00"),
    })

    const message = yield* new ImapFlowClient(raw).fetchOne(123)

    expect(message?.envelope).toEqual({ subject: "Codigo 123456" })
  }),
)

function clientWithSearchError(error: Error): ImapFlowClient {
  const raw = new ImapFlow({
    host: "imap.example.com",
    port: 993,
    secure: true,
    auth: { user: "user@example.com", pass: "app-password" },
    logger: false,
  })
  raw.search = async () => {
    throw error
  }
  return new ImapFlowClient(raw)
}
