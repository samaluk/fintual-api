import {
  Config,
  ConfigProvider,
  Context,
  Cron,
  Effect,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect"

import { parseSchedule, type SchedulerOptions } from "./scheduler.ts"

export class RuntimeConfigError extends Schema.TaggedError<RuntimeConfigError>()(
  "RuntimeConfigError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface ActualConfig {
  serverUrl: string
  password: Redacted.Redacted<string>
  syncId: string
  fintualAccount: string
  startingDate: string
  payee: string
}

export class ActualConfigService extends Context.Service<ActualConfigService, ActualConfig>()(
  "ActualConfig",
) {}

export interface Email2FAConfig {
  userEmail: string
  appPassword: Redacted.Redacted<string>
  host: string
  port: number
  debug: boolean
  sender: string
}

export interface FintualConfig {
  email: string
  password: Redacted.Redacted<string>
  goalId: string
}

export type RunMode = "once" | "schedule"

export interface ScheduleConfig extends Omit<SchedulerOptions, "cron"> {
  mode: RunMode
  cron: Cron.Cron
}

export class FintualConfigService extends Context.Service<FintualConfigService, FintualConfig>()(
  "FintualConfig",
) {}

export class Email2FAConfigService extends Context.Service<
  Email2FAConfigService,
  Option.Option<Email2FAConfig>
>()("Email2FAConfig") {}

export class ScheduleConfigService extends Context.Service<ScheduleConfigService, ScheduleConfig>()(
  "ScheduleConfig",
) {}

export interface RuntimeConfig {
  actual: ActualConfig
  fintual: FintualConfig
  email2FA: Email2FAConfig | null
  schedule: ScheduleConfig
}

export type Environment = Readonly<Record<string, string | undefined>>

export const resolveRuntimeConfig = Effect.fn("RuntimeConfig.resolveRuntimeConfig")(function* (
  environment: Environment,
): Effect.fn.Return<RuntimeConfig, RuntimeConfigError> {
  const provider = ConfigProvider.fromUnknown(
    Object.fromEntries(
      Object.entries(environment).flatMap(([name, value]) =>
        value === undefined || (value === "" && !isGmailCredential(name))
          ? []
          : [[name, normalizeEnvValue(value)]],
      ),
    ),
    { preserveEmptyStrings: true },
  )
  const values = yield* runtimeValueConfig.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
    Effect.mapError(
      (cause) =>
        new RuntimeConfigError({
          message: cause.message,
          cause,
        }),
    ),
  )
  const email2FA = yield* resolveEmail2FAConfig(
    provider,
    values.gmailUserEmail,
    values.gmailAppPassword,
  )

  return {
    actual: {
      serverUrl: values.actualServerUrl,
      password: values.actualPassword,
      syncId: values.actualSyncId,
      fintualAccount: values.actualFintualAccount,
      startingDate: values.actualStartingDate,
      payee: values.actualPayee,
    },
    fintual: {
      email: values.fintualUserEmail,
      password: values.fintualUserPassword,
      goalId: values.fintualGoalId,
    },
    email2FA,
    schedule: yield* resolveScheduleConfig(values),
  }
})

const runtimeValueConfig = Config.all({
  actualServerUrl: Config.string("ACTUAL_SERVER_URL"),
  actualPassword: Config.redacted("ACTUAL_PASSWORD"),
  actualSyncId: Config.string("ACTUAL_SYNC_ID"),
  actualFintualAccount: Config.string("ACTUAL_FINTUAL_ACCOUNT"),
  actualStartingDate: Config.string("ACTUAL_STARTING_DATE").pipe(
    Config.orElse(() => Config.string("STARTING_DATE")),
    Config.withDefault("2024-03-01"),
  ),
  actualPayee: Config.string("ACTUAL_PAYEE").pipe(Config.withDefault("Fintual")),
  fintualUserEmail: Config.string("FINTUAL_USER_EMAIL"),
  fintualUserPassword: Config.redacted("FINTUAL_USER_PASSWORD"),
  fintualGoalId: Config.string("FINTUAL_GOAL_ID"),
  gmailUserEmail: Config.option(Config.string("GMAIL_USER_EMAIL")),
  gmailAppPassword: Config.option(Config.redacted("GMAIL_APP_PASSWORD")),
  runMode: Config.literals(["once", "schedule"], "RUN_MODE").pipe(Config.withDefault("once")),
  syncCron: Config.string("SYNC_CRON").pipe(Config.withDefault("0 0 22 * * 1-5")),
  syncTimezone: Config.string("SYNC_TIMEZONE").pipe(Config.withDefault("America/Santiago")),
  syncNoOverlap: Config.boolean("SYNC_NO_OVERLAP").pipe(Config.withDefault(false)),
})

const resolveScheduleConfig = Effect.fn("RuntimeConfig.resolveScheduleConfig")(function* (values: {
  readonly runMode: RunMode
  readonly syncCron: string
  readonly syncTimezone: string
  readonly syncNoOverlap: boolean
}): Effect.fn.Return<ScheduleConfig, RuntimeConfigError> {
  const parsed = parseSchedule(values.syncCron, values.syncTimezone)
  if (Result.isFailure(parsed)) {
    return yield* new RuntimeConfigError({
      message: parsed.failure.message,
      cause: parsed.failure,
    })
  }

  return {
    mode: values.runMode,
    cron: parsed.success,
    timezone: values.syncTimezone,
    noOverlap: values.syncNoOverlap,
  }
})

const email2FAValueConfig = Config.all({
  gmailImapHost: Config.string("GMAIL_IMAP_HOST").pipe(Config.withDefault("imap.gmail.com")),
  gmailImapPort: Config.port("GMAIL_IMAP_PORT").pipe(Config.withDefault(993)),
  gmailImapDebug: Config.string("GMAIL_IMAP_DEBUG").pipe(
    Config.withDefault(""),
    Config.map((value) => ["1", "true"].includes(value.toLowerCase())),
  ),
  fintual2FASender: Config.string("FINTUAL_2FA_SENDER").pipe(
    Config.withDefault("notificaciones@fintual.com"),
  ),
})

const resolveEmail2FAConfig = Effect.fn("RuntimeConfig.resolveEmail2FAConfig")(function* (
  provider: ConfigProvider.ConfigProvider,
  userEmail: Option.Option<string>,
  appPassword: Option.Option<Redacted.Redacted<string>>,
): Effect.fn.Return<Email2FAConfig | null, RuntimeConfigError> {
  if (Option.isNone(userEmail) && Option.isNone(appPassword)) {
    return null
  }

  if (Option.isNone(userEmail)) {
    return yield* missingEmail2FACredential("GMAIL_USER_EMAIL")
  }

  if (Option.isNone(appPassword)) {
    return yield* missingEmail2FACredential("GMAIL_APP_PASSWORD")
  }

  return yield* email2FAValueConfig.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
    Effect.mapError(
      (cause) =>
        new RuntimeConfigError({
          message: cause.message,
          cause,
        }),
    ),
    Effect.map((values) => ({
      userEmail: userEmail.value,
      appPassword: appPassword.value,
      host: values.gmailImapHost,
      port: values.gmailImapPort,
      debug: values.gmailImapDebug,
      sender: values.fintual2FASender,
    })),
  )
})

function missingEmail2FACredential(name: string): Effect.Effect<never, RuntimeConfigError> {
  const cause = new Error(`Missing environment variables: ${name}`)
  return Effect.fail(new RuntimeConfigError({ message: cause.message, cause }))
}

function isGmailCredential(name: string): boolean {
  return name === "GMAIL_USER_EMAIL" || name === "GMAIL_APP_PASSWORD"
}

function normalizeEnvValue(value: string): string {
  const trimmedValue = value.trim()
  const startsWithQuote = trimmedValue.startsWith('"') || trimmedValue.startsWith("'")
  const endsWithQuote = trimmedValue.endsWith('"') || trimmedValue.endsWith("'")

  if (startsWithQuote && endsWithQuote && trimmedValue.length >= 2) {
    return trimmedValue.slice(1, -1).trim()
  }

  return trimmedValue
}

export function redactionSecrets(config: RuntimeConfig): ReadonlyArray<string> {
  return [
    config.actual.serverUrl,
    Redacted.value(config.actual.password),
    config.actual.syncId,
    config.actual.fintualAccount,
    config.fintual.email,
    Redacted.value(config.fintual.password),
    config.fintual.goalId,
    config.email2FA?.userEmail,
    config.email2FA ? Redacted.value(config.email2FA.appPassword) : undefined,
  ].filter((value): value is string => Boolean(value))
}
