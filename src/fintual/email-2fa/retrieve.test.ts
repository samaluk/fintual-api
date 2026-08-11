import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import type { SearchObject } from "imapflow"
import type { Email2FAConfig } from "../../env.ts"
import {
  MissingServerExtension,
  type ImapClient,
  type ImapMailboxLock,
  type ImapMessage,
} from "../email-2fa-client.ts"
import {
  Email2FACode,
  ImapClientFactory,
  Operational,
  retrieveEmail2FACode,
  TimedOut,
  type Email2FAOptions,
} from "./retrieve.ts"

const AFTER_TIMESTAMP = new Date("2026-07-14T10:30:00")

const NON_GMAIL_CONFIG: Email2FAConfig = {
  userEmail: "investor@example.com",
  appPassword: "app-password",
  host: "imap.example.com",
  port: 993,
  debug: false,
  sender: "security@fintual.com",
}

const GMAIL_CONFIG: Email2FAConfig = { ...NON_GMAIL_CONFIG, host: "imap.gmail.com" }

interface FakeClientOptions {
  connectError?: Error
  lockFailures?: ReadonlySet<string>
  search?: (query: SearchObject, searchCount: number) => number[] | false | Error
  fetchOne?: (uid: number) => ImapMessage | null | Error
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
    connect: () => {
      ops.push("connect")
      if (options.connectError) {
        return Effect.fail(options.connectError)
      }
      return Effect.sync(() => {
        usable = true
      })
    },
    getMailboxLock: (path: string): Effect.Effect<ImapMailboxLock, Error> => {
      ops.push(`lock:${path}`)
      if (options.lockFailures?.has(path)) {
        return Effect.fail(new Error(`missing mailbox ${path}`))
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
    logout: () => {
      ops.push("logout")
      return Effect.void
    },
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

function runRetrieval(
  config: Email2FAConfig,
  options: Email2FAOptions,
  client: ImapClient,
  step: (fiber: Fiber.Fiber<Email2FACode, TimedOut | Operational>) => Effect.Effect<unknown>,
): Promise<Exit.Exit<Email2FACode, TimedOut | Operational>> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* retrieveEmail2FACode(config, options).pipe(
        Effect.provideService(ImapClientFactory, { create: () => client }),
        Effect.forkChild,
      )
      yield* step(fiber)
      return yield* Fiber.await(fiber)
    }).pipe(Effect.provide(TestClock.layer())),
  )
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

describe("retrieveEmail2FACode", () => {
  test("returns the branded code on the first poll and logs out exactly once", async () => {
    const fake = createFakeClient({
      search: () => [123],
      fetchOne: () => messageWithCode("123456"),
    })

    const exit = await runRetrieval(
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
  })

  test("polls once per poll interval until a code appears", async () => {
    const fake = createFakeClient({
      search: (_, searchCount) => (searchCount >= 3 ? [456] : false),
      fetchOne: () => messageWithCode("654321"),
    })

    const exit = await runRetrieval(
      NON_GMAIL_CONFIG,
      { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
      fake.client,
      () => TestClock.adjust("6 seconds"),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(fake.searchCount()).toBe(3)
    expect(countOps(fake.ops, "logout")).toBe(1)
  })

  test("times out after the default 120 second window with TimedOut and a single logout", async () => {
    const fake = createFakeClient({ search: () => false })

    const exit = await runRetrieval(
      NON_GMAIL_CONFIG,
      { afterTimestamp: AFTER_TIMESTAMP },
      fake.client,
      () => TestClock.adjust("2 minutes"),
    )

    expect(failureOf(exit)).toBeInstanceOf(TimedOut)
    expect(countOps(fake.ops, "connect")).toBe(1)
    expect(countOps(fake.ops, "logout")).toBe(1)
  })

  test("surfaces a connect failure as Operational without logging out", async () => {
    const fake = createFakeClient({
      connectError: new Error("connection refused"),
      search: () => false,
    })

    const exit = await runRetrieval(
      NON_GMAIL_CONFIG,
      { afterTimestamp: AFTER_TIMESTAMP },
      fake.client,
      () => Effect.void,
    )

    expect(failureOf(exit)).toBeInstanceOf(Operational)
    expect(countOps(fake.ops, "connect")).toBe(1)
    expect(countOps(fake.ops, "logout")).toBe(0)
  })

  test("logs out exactly once when the retrieval fiber is interrupted", async () => {
    const fake = createFakeClient({ search: () => false })

    const exit = await runRetrieval(
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
  })
})

describe("retrieveEmail2FACode recoverability", () => {
  test("skips a mailbox whose lock fails and keeps searching the remaining mailboxes", async () => {
    const fake = createFakeClient({
      lockFailures: new Set(["INBOX"]),
      search: () => false,
    })

    const exit = await runRetrieval(
      GMAIL_CONFIG,
      { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000, timeoutMs: 4_000 },
      fake.client,
      () => TestClock.adjust("4 seconds"),
    )

    expect(failureOf(exit)).toBeInstanceOf(TimedOut)
    expect(fake.ops).toContain("lock:[Gmail]/All Mail")
    expect(fake.ops).toContain("lock:[Gmail]/Spam")
    expect(countOps(fake.ops, "logout")).toBe(1)
  })

  test("skips a single message whose fetch fails and still returns the code from a later message", async () => {
    const fake = createFakeClient({
      search: () => [111, 222],
      fetchOne: (uid) => {
        if (uid === 111) {
          return new Error("message stream broken")
        }
        return messageWithCode("222222")
      },
    })

    const exit = await runRetrieval(
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
  })

  test("surfaces a search failure as Operational", async () => {
    const fake = createFakeClient({ search: () => new Error("IMAP search failed") })

    const exit = await runRetrieval(
      NON_GMAIL_CONFIG,
      { afterTimestamp: AFTER_TIMESTAMP },
      fake.client,
      () => Effect.void,
    )

    expect(failureOf(exit)).toBeInstanceOf(Operational)
    expect(countOps(fake.ops, "logout")).toBe(1)
  })

  test("pre-classifies a MissingServerExtension search failure and keeps polling", async () => {
    const fake = createFakeClient({
      search: (_, searchCount) =>
        searchCount === 1
          ? new MissingServerExtension({ cause: new Error("no X-GM-EXT-1") })
          : [333],
      fetchOne: () => messageWithCode("333333"),
    })

    const exit = await runRetrieval(
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
  })

  test("debug only toggles logging and does not change behavior", async () => {
    const scenario = () =>
      createFakeClient({
        lockFailures: new Set(["INBOX"]),
        search: (_, searchCount) => (searchCount >= 2 ? [444] : false),
        fetchOne: () => messageWithCode("444444"),
      })

    const quiet = scenario()
    const quietExit = await runRetrieval(
      { ...GMAIL_CONFIG, debug: false },
      { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
      quiet.client,
      () => TestClock.adjust("4 seconds"),
    )
    const verbose = scenario()
    const verboseExit = await runRetrieval(
      { ...GMAIL_CONFIG, debug: true },
      { afterTimestamp: AFTER_TIMESTAMP, pollIntervalMs: 2_000 },
      verbose.client,
      () => TestClock.adjust("4 seconds"),
    )

    expect(quietExit).toEqual(verboseExit)
    expect(quiet.ops).toEqual(verbose.ops)
  })
})

function messageWithCode(code: string): ImapMessage {
  return {
    source: Buffer.from(`Subject: Codigo ${code}\n\nCodigo: ${code}`),
    envelope: { subject: `Codigo ${code}` },
    internalDate: new Date("2026-07-14T10:31:00"),
  }
}
