import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import type { SearchObject } from "imapflow"
import { FintualConfigService, type Email2FAConfig, type FintualConfig } from "../env.ts"
import {
  ImapClientFactory,
  ImapMailboxLockFailure,
  ImapOperationFailure,
  MissingMailbox,
  MissingServerExtension,
  type ImapClient,
  type ImapMailboxLock,
  type ImapMessage,
} from "./email-2fa-client.ts"
import {
  Email2FACode,
  Email2FAService,
  Operational,
  TimedOut,
  type Email2FAOptions,
} from "./email-2fa.ts"

const AFTER_TIMESTAMP = new Date("2026-07-14T10:30:00")

const NON_GMAIL_CONFIG: Email2FAConfig = {
  userEmail: "investor@example.com",
  appPassword: Redacted.make("app-password"),
  host: "imap.example.com",
  port: 993,
  debug: false,
  sender: "security@fintual.com",
}

const GMAIL_CONFIG: Email2FAConfig = { ...NON_GMAIL_CONFIG, host: "imap.gmail.com" }

interface FakeClientOptions {
  connectError?: ImapOperationFailure
  lockFailures?: ReadonlySet<string>
  lockError?: ImapMailboxLockFailure
  search?: (
    query: SearchObject,
    searchCount: number,
  ) => number[] | false | ImapOperationFailure | MissingServerExtension
  fetchOne?: (uid: number) => ImapMessage | null | ImapOperationFailure
}

interface FakeClient {
  client: ImapClient
  ops: string[]
  searchCount: () => number
}

function createFakeClient(options: FakeClientOptions = {}): FakeClient {
  const ops: string[] = []
  let usable = false
  let searches = 0

  const client: ImapClient = {
    get usable() {
      return usable
    },
    connect: Effect.suspend(() => {
      ops.push("connect")
      if (options.connectError) {
        return Effect.fail(options.connectError)
      }
      return Effect.sync(() => {
        usable = true
      })
    }),
    getMailboxLock: (
      path: string,
    ): Effect.Effect<ImapMailboxLock, ImapMailboxLockFailure | MissingMailbox> => {
      ops.push(`lock:${path}`)
      if (options.lockError) {
        return Effect.fail(options.lockError)
      }
      if (options.lockFailures?.has(path)) {
        return Effect.fail(
          new MissingMailbox({ path, cause: new Error(`missing mailbox ${path}`) }),
        )
      }
      return Effect.sync(() => ({
        release: () => {
          ops.push(`release:${path}`)
        },
      }))
    },
    search: (query) => {
      ops.push("search")
      searches += 1
      const result = options.search?.(query, searches) ?? false
      if (result instanceof Error) {
        return Effect.fail(result)
      }
      return Effect.succeed(result)
    },
    fetchOne: (uid) => {
      ops.push(`fetchOne:${uid}`)
      const result = options.fetchOne?.(uid) ?? null
      if (result instanceof Error) {
        return Effect.fail(result)
      }
      return Effect.succeed(result)
    },
    logout: Effect.sync(() => {
      ops.push("logout")
    }),
  }

  return {
    client,
    ops,
    searchCount: () => searches,
  }
}

function countOps(ops: string[], name: string): number {
  return ops.filter((op) => op === name).length
}

function fintualConfig(email2FA: Email2FAConfig | null): FintualConfig {
  return {
    email: "investor@example.com",
    password: Redacted.make("secret-password"),
    goalId: "goal-123",
    email2FA,
  }
}

function runRetrieval(
  config: Email2FAConfig,
  options: Email2FAOptions,
  client: ImapClient,
  step: (fiber: Fiber.Fiber<Email2FACode, TimedOut | Operational>) => Effect.Effect<unknown>,
): Effect.Effect<Exit.Exit<Email2FACode, TimedOut | Operational>> {
  return Effect.gen(function* () {
    const fiber = yield* Effect.gen(function* () {
      const service = yield* Email2FAService
      return yield* service.get2FACode(options)
    }).pipe(
      Effect.provide(Email2FAService.layer),
      Effect.provideService(FintualConfigService, fintualConfig(config)),
      Effect.provideService(ImapClientFactory, { create: () => client }),
      Effect.forkChild,
    )
    yield* step(fiber)
    return yield* Fiber.await(fiber)
  })
}

function failureOf(exit: Exit.Exit<Email2FACode, TimedOut | Operational>): TimedOut | Operational {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) {
    throw new Error("expected a failed exit")
  }
  return Option.getOrThrowWith(
    Cause.findErrorOption(exit.cause),
    () => new Error("expected a typed failure"),
  )
}

describe("Email2FAService.get2FACode", () => {
  it.effect("returns the branded code on the first poll and logs out exactly once", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({
        search: () => [123],
        fetchOne: () => messageWithCode("123456"),
      })

      const exit = yield* runRetrieval(
        NON_GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP },
        fake.client,
        () => Effect.void,
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toBe(Email2FACode.make("123456"))
      }
      expect(fake.ops).toContain("connect")
      expect(countOps(fake.ops, "logout")).toBe(1)
    }),
  )

  it.effect("polls once per poll interval until a code appears", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({
        search: (_, searchCount) => (searchCount >= 3 ? [456] : false),
        fetchOne: () => messageWithCode("654321"),
      })

      const exit = yield* runRetrieval(
        NON_GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
        fake.client,
        () => TestClock.adjust("6 seconds"),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(fake.searchCount()).toBe(3)
      expect(countOps(fake.ops, "logout")).toBe(1)
    }),
  )

  it.effect("times out after the default 120 second window with TimedOut and a single logout", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({ search: () => false })

      const exit = yield* runRetrieval(
        NON_GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP },
        fake.client,
        () => TestClock.adjust("2 minutes"),
      )

      expect(failureOf(exit)).toBeInstanceOf(TimedOut)
      expect(countOps(fake.ops, "connect")).toBe(1)
      expect(countOps(fake.ops, "logout")).toBe(1)
    }),
  )

  it.effect("surfaces a connect failure as Operational without logging out", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({
        connectError: new ImapOperationFailure({
          stage: "Failed to connect to Gmail IMAP",
          cause: new Error("connection refused"),
        }),
        search: () => false,
      })

      const exit = yield* runRetrieval(
        NON_GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP },
        fake.client,
        () => Effect.void,
      )

      expect(failureOf(exit)).toBeInstanceOf(Operational)
      expect(countOps(fake.ops, "connect")).toBe(1)
      expect(countOps(fake.ops, "logout")).toBe(0)
    }),
  )

  it.effect("logs out exactly once when the retrieval fiber is interrupted", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({ search: () => false })

      const exit = yield* runRetrieval(
        NON_GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
        fake.client,
        (fiber) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("1 second")
            return yield* Fiber.interrupt(fiber)
          }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(countOps(fake.ops, "connect")).toBe(1)
      expect(countOps(fake.ops, "logout")).toBe(1)
    }),
  )
})

describe("Email2FAService.get2FACode recoverability", () => {
  it.effect("skips a mailbox whose lock fails and keeps searching the remaining mailboxes", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({
        lockFailures: new Set(["INBOX"]),
        search: () => false,
      })

      const exit = yield* runRetrieval(
        GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000, timeoutMs: 5_000 },
        fake.client,
        () => TestClock.adjust("5 seconds"),
      )

      expect(failureOf(exit)).toBeInstanceOf(TimedOut)
      expect(fake.ops).toContain("lock:[Gmail]/All Mail")
      expect(fake.ops).toContain("lock:[Gmail]/Spam")
      expect(countOps(fake.ops, "logout")).toBe(1)
    }),
  )

  it.effect("surfaces a non-missing mailbox lock failure as Operational", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({
        lockError: new ImapMailboxLockFailure({
          path: "INBOX",
          cause: new Error("connection dropped"),
        }),
      })

      const exit = yield* runRetrieval(
        GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP },
        fake.client,
        () => Effect.void,
      )

      expect(failureOf(exit)).toBeInstanceOf(Operational)
      expect(fake.ops).not.toContain("lock:[Gmail]/All Mail")
      expect(countOps(fake.ops, "logout")).toBe(1)
    }),
  )

  it.effect(
    "skips a single message whose fetch fails and still returns the code from a later message",
    () =>
      Effect.gen(function* () {
        const fake = createFakeClient({
          search: () => [111, 222],
          fetchOne: (uid) => {
            if (uid === 111) {
              return new ImapOperationFailure({
                stage: "Failed to fetch Gmail IMAP message",
                cause: new Error("message stream broken"),
              })
            }
            return messageWithCode("222222")
          },
        })

        const exit = yield* runRetrieval(
          NON_GMAIL_CONFIG,
          { afterTimestamp: AFTER_TIMESTAMP },
          fake.client,
          () => Effect.void,
        )

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value).toBe(Email2FACode.make("222222"))
        }
        expect(fake.ops).toContain("fetchOne:111")
        expect(fake.ops).toContain("fetchOne:222")
        expect(countOps(fake.ops, "logout")).toBe(1)
      }),
  )

  it.effect("retries a message fetch failure on the next poll", () =>
    Effect.gen(function* () {
      let fetches = 0
      const fake = createFakeClient({
        search: () => [111],
        fetchOne: () => {
          fetches += 1
          return fetches === 1
            ? new ImapOperationFailure({
                stage: "Failed to fetch Gmail IMAP message",
                cause: new Error("message stream broken"),
              })
            : messageWithCode("111111")
        },
      })

      const exit = yield* runRetrieval(
        NON_GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
        fake.client,
        () => TestClock.adjust("2 seconds"),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toBe(Email2FACode.make("111111"))
      }
      expect(countOps(fake.ops, "fetchOne:111")).toBe(2)
      expect(countOps(fake.ops, "logout")).toBe(1)
    }),
  )

  it.effect("does not re-fetch a message UID already seen on a previous poll", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({
        search: (_, searchCount) => (searchCount === 1 ? [555] : [555, 666]),
        fetchOne: (uid) =>
          uid === 555
            ? { ...messageWithCode("111111"), internalDate: new Date("2026-07-14T10:20:00") }
            : messageWithCode("666666"),
      })

      const exit = yield* runRetrieval(
        NON_GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
        fake.client,
        () => TestClock.adjust("2 seconds"),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toBe(Email2FACode.make("666666"))
      }
      expect(countOps(fake.ops, "fetchOne:555")).toBe(1)
      expect(countOps(fake.ops, "fetchOne:666")).toBe(1)
    }),
  )

  it.effect("surfaces a search failure as Operational", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({
        search: () =>
          new ImapOperationFailure({
            stage: "Failed to search Gmail IMAP mailbox",
            cause: new Error("IMAP search failed"),
          }),
      })

      const exit = yield* runRetrieval(
        NON_GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP },
        fake.client,
        () => Effect.void,
      )

      expect(failureOf(exit)).toBeInstanceOf(Operational)
      expect(countOps(fake.ops, "logout")).toBe(1)
    }),
  )

  it.effect("pre-classifies a MissingServerExtension search failure and keeps polling", () =>
    Effect.gen(function* () {
      const fake = createFakeClient({
        search: (_, searchCount) =>
          searchCount === 1
            ? new MissingServerExtension({ cause: new Error("no X-GM-EXT-1") })
            : [333],
        fetchOne: () => messageWithCode("333333"),
      })

      const exit = yield* runRetrieval(
        NON_GMAIL_CONFIG,
        { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
        fake.client,
        () => TestClock.adjust("4 seconds"),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toBe(Email2FACode.make("333333"))
      }
      expect(fake.searchCount()).toBe(2)
      expect(countOps(fake.ops, "logout")).toBe(1)
    }),
  )

  it.effect("debug only toggles logging and does not change behavior", () =>
    Effect.gen(function* () {
      const scenario = () =>
        createFakeClient({
          lockFailures: new Set(["INBOX"]),
          search: (_, searchCount) => (searchCount >= 2 ? [444] : false),
          fetchOne: () => messageWithCode("444444"),
        })

      const quiet = scenario()
      const quietExit = yield* runRetrieval(
        { ...GMAIL_CONFIG, debug: false },
        { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
        quiet.client,
        () => TestClock.adjust("4 seconds"),
      )
      const verbose = scenario()
      const verboseExit = yield* runRetrieval(
        { ...GMAIL_CONFIG, debug: true },
        { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
        verbose.client,
        () => TestClock.adjust("4 seconds"),
      )

      expect(quietExit).toEqual(verboseExit)
      expect(quiet.ops).toEqual(verbose.ops)
    }),
  )
})

function messageWithCode(code: string): ImapMessage {
  return {
    source: Buffer.from(`Subject: Codigo ${code}\n\nCodigo: ${code}`),
    envelope: { subject: `Codigo ${code}` },
    internalDate: new Date("2026-07-14T10:31:00"),
  }
}
