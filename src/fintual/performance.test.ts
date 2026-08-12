import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { describe, expect } from "vitest"

import { FintualConfigService, type FintualConfig } from "../env.ts"
import { SnapshotWriter, type PerformanceSnapshot } from "../performance-snapshot.ts"
import { Email2FACode, Email2FAService, Operational, TimedOut } from "./email-2fa.ts"
import {
  Email2FAFailure,
  HttpTransportFailure,
  LoginFailed,
  MalformedGoalPerformanceData,
  SnapshotWriteFailure,
  UnexpectedHttpStatus,
} from "./fintual-error.ts"
import { FintualPerformance } from "./performance.ts"
import { FintualProvider, type GoalPerformanceData } from "./provider.ts"

const CONFIG: FintualConfig = {
  email: "investor@example.com",
  password: Redacted.make("secret-password"),
  goalId: "goal-123",
  email2FA: {
    userEmail: "inbox@example.com",
    appPassword: Redacted.make("app-password"),
    host: "imap.example.com",
    port: 993,
    debug: false,
    sender: "notifications@example.com",
  },
}

interface TestOverrides {
  signIn?: FintualProvider["Service"]["signIn"]
  fetchReference?: FintualProvider["Service"]["fetchReferenceGoalPerformanceData"]
  fetchRecent?: FintualProvider["Service"]["fetchRecentGoalPerformanceData"]
  get2FACode?: Email2FAService["Service"]["get2FACode"]
  write?: SnapshotWriter["Service"]["write"]
  config?: FintualConfig
}

function performanceProgram(overrides: TestOverrides = {}) {
  const program = Effect.gen(function* () {
    const service = yield* FintualPerformance
    return yield* service.fetchPerformanceSnapshot
  })

  return program.pipe(
    Effect.provide(FintualPerformance.layer),
    Effect.provideService(FintualConfigService, overrides.config ?? CONFIG),
    Effect.provideService(FintualProvider, {
      signIn: overrides.signIn ?? (() => Effect.void),
      fetchReferenceGoalPerformanceData:
        overrides.fetchReference ??
        Effect.succeed(goalPerformanceData("2026-01-01", { costBasis: 80, valuation: 100 })),
      fetchRecentGoalPerformanceData:
        overrides.fetchRecent ??
        Effect.succeed(goalPerformanceData("2026-07-01", { costBasis: 90, valuation: 115 })),
    }),
    Effect.provideService(Email2FAService, {
      get2FACode: overrides.get2FACode ?? (() => Effect.succeed(Email2FACode.make("123456"))),
    }),
    Effect.provideService(SnapshotWriter, {
      write: overrides.write ?? (() => Effect.void),
    }),
  )
}

const email2FASignIn = (
  requestCode: (afterTimestamp: Date) => Effect.Effect<Email2FACode, TimedOut | Operational>,
): Effect.Effect<void, Email2FAFailure> =>
  requestCode(new Date("2026-07-14T10:30:00")).pipe(
    Effect.andThen(() => Effect.void),
    Effect.catchTags({
      TimedOut: () =>
        Effect.fail(
          new Email2FAFailure({
            stage: "Fintual email 2FA",
            cause: new Error("Fintual email 2FA: no code received before timeout"),
          }),
        ),
      Operational: (failure) =>
        Effect.fail(new Email2FAFailure({ stage: "Fintual email 2FA", cause: failure.cause })),
    }),
  )

it.effect(
  "returns a validated Performance Snapshot after direct login and persists exactly one artifact",
  () =>
    Effect.gen(function* () {
      const written: PerformanceSnapshot[] = []
      let signInRequests = 0

      const snapshot = yield* performanceProgram({
        signIn: () => {
          signInRequests += 1
          return Effect.void
        },
        write: (value) => Effect.sync(() => written.push(value)),
      })

      expect(snapshot).toEqual({
        balance: [
          { date: Date.parse("2026-07-01"), value: 115, difference: 5, real_difference: 5 },
        ],
        deposits: [{ date: Date.parse("2026-07-01"), value: 90, difference: 10 }],
      })
      expect(written).toEqual([snapshot])
      expect(signInRequests).toBe(1)
    }),
)

it.effect("builds the live layer without Email 2FA configuration", () =>
  Effect.gen(function* () {
    const service = yield* FintualPerformance

    expect(Effect.isEffect(service.fetchPerformanceSnapshot)).toBe(true)
  }).pipe(
    Effect.provide(FintualPerformance.live),
    Effect.provideService(FintualConfigService, { ...CONFIG, email2FA: null }),
  ),
)

it.effect("direct login succeeds when Email 2FA is not configured", () =>
  Effect.gen(function* () {
    let codeRequests = 0

    const snapshot = yield* performanceProgram({
      config: { ...CONFIG, email2FA: null },
      get2FACode: () => {
        codeRequests += 1
        return Effect.succeed(Email2FACode.make("123456"))
      },
    })

    expect(codeRequests).toBe(0)
    expect(snapshot.balance).toHaveLength(1)
  }),
)

it.effect("completes Email 2FA sign-in before it requests Goal Performance Data", () =>
  Effect.gen(function* () {
    let codeRequests = 0
    let submittedCode: Email2FACode | undefined

    const snapshot = yield* performanceProgram({
      signIn: (requestCode) =>
        requestCode(new Date("2026-07-14T10:30:00")).pipe(
          Effect.map((code) => {
            codeRequests += 1
            submittedCode = code
          }),
          Effect.catchTags({
            TimedOut: () =>
              Effect.fail(
                new Email2FAFailure({
                  stage: "Fintual email 2FA",
                  cause: new Error("Fintual email 2FA: no code received before timeout"),
                }),
              ),
            Operational: (failure) =>
              Effect.fail(
                new Email2FAFailure({ stage: "Fintual email 2FA", cause: failure.cause }),
              ),
          }),
        ),
    })

    expect(codeRequests).toBe(1)
    expect(submittedCode).toBe(Email2FACode.make("123456"))
    expect(snapshot.balance).toHaveLength(1)
  }),
)

describe("fails when Email 2FA cannot produce a code", () => {
  it.effect("login requires 2FA but Gmail credentials are not configured", () =>
    Effect.gen(function* () {
      let codeRequests = 0

      const error = yield* Effect.flip(
        performanceProgram({
          config: { ...CONFIG, email2FA: null },
          get2FACode: () => {
            codeRequests += 1
            return Effect.succeed(Email2FACode.make("123456"))
          },
          signIn: email2FASignIn,
        }),
      )

      expect(error).toMatchObject({
        _tag: "Email2FAFailure",
        stage: "Fintual email 2FA",
        message: "Fintual email 2FA: Gmail IMAP credentials not configured",
      })
      expect(codeRequests).toBe(0)
    }),
  )

  it.effect("code retrieval times out", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        performanceProgram({
          get2FACode: () => Effect.fail(new TimedOut()),
          signIn: email2FASignIn,
        }),
      )

      expect(error).toMatchObject({
        _tag: "Email2FAFailure",
        stage: "Fintual email 2FA",
        message: "Fintual email 2FA: no code received before timeout",
      })
    }),
  )

  it.effect("operational failure preserves its IMAP cause and sign-in stage", () =>
    Effect.gen(function* () {
      const imapCause = new Error("IMAP connection refused")

      const error = yield* Effect.flip(
        performanceProgram({
          get2FACode: () => Effect.fail(new Operational({ cause: imapCause })),
          signIn: email2FASignIn,
        }),
      )

      expect(error).toMatchObject({
        _tag: "Email2FAFailure",
        stage: "Fintual email 2FA",
        cause: imapCause,
      })
      if (error instanceof Error) {
        expect(error.cause).toBe(imapCause)
      }
    }),
  )
})

it.effect("fails with LoginFailed when the provider rejects sign-in", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      performanceProgram({
        signIn: () => Effect.fail(new LoginFailed({ status: 401 })),
      }),
    )

    expect(error).toMatchObject({
      _tag: "LoginFailed",
      status: 401,
    })
  }),
)

it.effect("fails on an unexpected sign-in status", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      performanceProgram({
        signIn: () =>
          Effect.fail(new UnexpectedHttpStatus({ stage: "Fintual login", status: 418 })),
      }),
    )

    expect(error).toMatchObject({
      _tag: "UnexpectedHttpStatus",
      stage: "Fintual login",
      status: 418,
    })
  }),
)

it.effect("fails with HttpTransportFailure when provider sign-in transport fails", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      performanceProgram({
        signIn: () =>
          Effect.fail(
            new HttpTransportFailure({
              stage: "Fintual sign-in page",
              cause: new Error("network down"),
            }),
          ),
      }),
    )

    expect(error).toMatchObject({
      _tag: "HttpTransportFailure",
      stage: "Fintual sign-in page",
    })
    if (error instanceof Error) {
      expect(error.cause).toBeInstanceOf(Error)
    }
  }),
)

describe("fails when Goal Performance Data is unavailable", () => {
  it.effect("reference request", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        performanceProgram({
          fetchReference: Effect.fail(
            new MalformedGoalPerformanceData({
              purpose: "reference",
              cause: new Error("malformed response"),
            }),
          ),
        }),
      )

      expect(error).toMatchObject({
        _tag: "MalformedGoalPerformanceData",
        purpose: "reference",
      })
      if (error instanceof Error) {
        expect(error.cause).toBeInstanceOf(Error)
      }
    }),
  )

  it.effect("recent request", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        performanceProgram({
          fetchRecent: Effect.fail(
            new UnexpectedHttpStatus({
              stage: "Fintual recent Goal Performance Data",
              status: 503,
            }),
          ),
        }),
      )

      expect(error).toMatchObject({
        _tag: "UnexpectedHttpStatus",
        stage: "Fintual recent Goal Performance Data",
        status: 503,
      })
    }),
  )

  it.effect("reference transport failure", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        performanceProgram({
          fetchReference: Effect.fail(
            new HttpTransportFailure({
              stage: "Fintual reference Goal Performance Data",
              cause: new Error("connection reset"),
            }),
          ),
        }),
      )

      expect(error).toMatchObject({
        _tag: "HttpTransportFailure",
        stage: "Fintual reference Goal Performance Data",
      })
    }),
  )
})

it.effect("fails with MalformedPerformanceSnapshot when the fold output is invalid", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      performanceProgram({
        fetchRecent: Effect.succeed({ balanceGraphDataPoints: [] }),
      }),
    )

    expect(error).toMatchObject({
      _tag: "MalformedPerformanceSnapshot",
    })
  }),
)

it.effect("fails with SnapshotWriteFailure when the snapshot cannot be written", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      performanceProgram({
        write: () => Effect.fail(new SnapshotWriteFailure({ cause: new Error("disk full") })),
      }),
    )

    expect(error).toMatchObject({ _tag: "SnapshotWriteFailure" })
    if (error instanceof Error) {
      expect(error.cause).toBeInstanceOf(Error)
    }
  }),
)

function goalPerformanceData(
  date: string,
  amounts: { costBasis?: number; valuation?: number } = {},
): GoalPerformanceData {
  const costBasis = amounts.costBasis ?? 100
  const valuation = amounts.valuation ?? 110

  return {
    balanceGraphDataPoints: [
      {
        date,
        unrealizedCostBasisAmount: costBasis,
        unrealizedGainOrLossAmount: 10,
        realizedCostBasisAmount: costBasis - 10,
        realizedGainOrLossAmount: 5,
        sharesCostBasisAmount: valuation - 15,
        sharesValuationAmount: valuation,
        pendingFulfillmentReinvestmentDepositsCostBasisAmount: 0,
        pendingFulfillmentReinvestmentDepositsAmount: 0,
        withdrawnAmount: 0,
      },
    ],
  }
}
