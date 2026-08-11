import { Effect } from "effect"
import { ImapFlow } from "imapflow"
import { expect, test } from "vitest"
import { ImapFlowClient, MissingServerExtension } from "./email-2fa-client.ts"

test("surfaces a MissingServerExtension search rejection as a typed error", async () => {
  const client = clientWithSearchError(
    Object.assign(new Error("Server does not support X-GM-EXT-1 extension"), {
      code: "MissingServerExtension",
    }),
  )

  const error = await Effect.runPromise(Effect.flip(client.search({ gmraw: "from:a" })))

  expect(error).toBeInstanceOf(MissingServerExtension)
})

test("surfaces a plain search failure with the preserved message and original cause", async () => {
  const originalError = new Error("boom")
  const client = clientWithSearchError(originalError)

  const error = await Effect.runPromise(Effect.flip(client.search({ gmraw: "from:a" })))

  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(MissingServerExtension)
  expect(error.message).toBe("Failed to search Gmail IMAP mailbox: boom")
  expect(error.cause).toBe(originalError)
})

test("exposes only the subject from the message envelope across the seam", async () => {
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

  const message = await Effect.runPromise(new ImapFlowClient(raw).fetchOne(123))

  expect(message?.envelope).toEqual({ subject: "Codigo 123456" })
})

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
