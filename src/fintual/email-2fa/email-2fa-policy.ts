import { Effect, Schema } from "effect"
import type { SearchObject } from "imapflow"
import { simpleParser } from "mailparser"

import { getErrorMessage } from "../../logging.ts"

export interface Email2FASearchPolicy {
  host: string
  sender: string
}

export interface Email2FACandidate {
  source: Buffer | Uint8Array
  envelopeSubject?: string
  receivedAt?: Date
}

export class EmailMessageParseFailure extends Schema.TaggedError<EmailMessageParseFailure>()(
  "EmailMessageParseFailure",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to parse Gmail IMAP message: ${getErrorMessage(this.cause)}`
  }
}

export function buildEmail2FASearchQueries(
  policy: Email2FASearchPolicy,
  afterTimestamp: Date,
): SearchObject[] {
  const queries: SearchObject[] = []

  if (isGmailImapHost(policy.host)) {
    const after = formatGmailAfterDate(afterTimestamp)
    queries.push({ gmraw: `from:${policy.sender} after:${after}` })
    queries.push({ gmraw: `from:fintual.com after:${after}` })
    // Relative queries cover date and timezone disagreement between Gmail and the caller.
    queries.push({ gmraw: `from:${policy.sender} newer_than:1d` })
    queries.push({ gmraw: "from:fintual.com newer_than:1d" })
  }

  queries.push({ from: policy.sender, since: afterTimestamp })
  return queries
}

export const selectEmail2FACode = Effect.fn("Email2FA.selectEmail2FACode")(function* (
  candidates: Iterable<Email2FACandidate>,
  afterTimestamp: Date,
): Effect.fn.Return<string | null, EmailMessageParseFailure> {
  for (const candidate of candidates) {
    if (candidate.receivedAt && candidate.receivedAt < afterTimestamp) {
      continue
    }

    const sources = yield* collectMessageSources(candidate)
    for (const source of sources) {
      const code = extractCodeFromText(source)
      if (code) {
        return code
      }
    }
  }

  return null
})

export function isGmailImapHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === "imap.gmail.com" || normalized === "imap.googlemail.com"
}

/** Gmail web-style search; avoids broken IMAP SUBJECT matching for UTF-8 (e.g. "Código"). */
function formatGmailAfterDate(date: Date): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  return `${yyyy}/${mm}/${dd}`
}

const collectMessageSources = Effect.fn("Email2FA.collectMessageSources")(function* (
  candidate: Email2FACandidate,
): Effect.fn.Return<string[], EmailMessageParseFailure> {
  const sources: string[] = []
  if (candidate.envelopeSubject) {
    sources.push(candidate.envelopeSubject)
  }

  const parsedMessage = yield* Effect.tryPromise({
    try: () => simpleParser(Buffer.from(candidate.source)),
    catch: (cause) => new EmailMessageParseFailure({ cause }),
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

  return candidates.find((candidate) => candidate !== "000000") ?? null
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
