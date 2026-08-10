import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { expect, test } from "vitest"
import {
  buildEmail2FASearchQueries,
  selectEmail2FACode,
  type Email2FACandidate,
} from "./email-2fa-policy.ts"

const AFTER_TIMESTAMP = new Date(2026, 6, 14, 10, 30)

test("builds Gmail sender, domain, relative-window, and portable fallback queries", () => {
  const queries = buildEmail2FASearchQueries(
    { host: "IMAP.GMAIL.COM", sender: "security@fintual.com" },
    AFTER_TIMESTAMP,
  )

  expect(queries).toEqual([
    { gmraw: "from:security@fintual.com after:2026/07/14" },
    { gmraw: "from:fintual.com after:2026/07/14" },
    { gmraw: "from:security@fintual.com newer_than:1d" },
    { gmraw: "from:fintual.com newer_than:1d" },
    { from: "security@fintual.com", since: AFTER_TIMESTAMP },
  ])
})

test("uses only the portable IMAP query outside Gmail", () => {
  expect(
    buildEmail2FASearchQueries(
      { host: "imap.example.com", sender: "security@example.com" },
      AFTER_TIMESTAMP,
    ),
  ).toEqual([{ from: "security@example.com", since: AFTER_TIMESTAMP }])
})

test.each([
  ["plain text", "2fa-plain.eml", "123456"],
  ["HTML", "2fa-html.eml", "234567"],
  ["quoted-printable", "2fa-quoted-printable.eml", "345678"],
])("selects a code from a captured %s message", async (_, fixtureName, expectedCode) => {
  const candidate = await loadFixture(fixtureName)

  const code = await Effect.runPromise(selectEmail2FACode([candidate], AFTER_TIMESTAMP))

  expect(code).toBe(expectedCode)
})

test("rejects stale and invalid candidates before selecting a fresh code", async () => {
  const candidates: Email2FACandidate[] = [
    {
      source: Buffer.from("Subject: Codigo 456789\n\nCodigo: 456789"),
      receivedAt: new Date(2026, 6, 14, 10, 29),
    },
    {
      source: Buffer.from("Subject: Codigo 000000\n\nCodigo: 000000"),
      receivedAt: new Date(2026, 6, 14, 10, 31),
    },
    {
      source: Buffer.from("Subject: Codigo 567890\n\nCodigo: 567890"),
      receivedAt: new Date(2026, 6, 14, 10, 32),
    },
  ]

  const code = await Effect.runPromise(selectEmail2FACode(candidates, AFTER_TIMESTAMP))

  expect(code).toBe("567890")
})

async function loadFixture(name: string): Promise<Email2FACandidate> {
  const source = await readFile(new URL(`./fixtures/${name}`, import.meta.url))
  return { source, receivedAt: new Date(2026, 6, 14, 10, 31) }
}
