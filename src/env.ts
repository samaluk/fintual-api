import { Config, ConfigProvider, Context, Effect, Option, Redacted, Schema } from "effect"

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
  email2FA: Email2FAConfig | null
}

export class FintualConfigService extends Context.Service<FintualConfigService, FintualConfig>()(
  "FintualConfig",
) {}

export interface RuntimeConfig {
  actual: ActualConfig
  fintual: FintualConfig
}

export type Environment = Readonly<Record<string, string | undefined>>

export function resolveRuntimeConfig(
  environment: Environment,
): Effect.Effect<RuntimeConfig, RuntimeConfigError> {
  return Effect.gen(function* () {
    const provider = ConfigProvider.fromUnknown(
      Object.fromEntries(
        Object.entries(environment).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, normalizeEnvValue(value)]],
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
        email2FA,
      },
    }
  })
}

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

function resolveEmail2FAConfig(
  provider: ConfigProvider.ConfigProvider,
  userEmail: Option.Option<string>,
  appPassword: Option.Option<Redacted.Redacted<string>>,
): Effect.Effect<Email2FAConfig | null, RuntimeConfigError> {
  if (Option.isNone(userEmail) && Option.isNone(appPassword)) {
    return Effect.succeed(null)
  }

  if (Option.isNone(userEmail)) {
    return missingEmail2FACredential("GMAIL_USER_EMAIL")
  }

  if (Option.isNone(appPassword)) {
    return missingEmail2FACredential("GMAIL_APP_PASSWORD")
  }

  return email2FAValueConfig.pipe(
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
}

function missingEmail2FACredential(name: string): Effect.Effect<never, RuntimeConfigError> {
  const cause = new Error(`Missing environment variables: ${name}`)
  return Effect.fail(new RuntimeConfigError({ message: cause.message, cause }))
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
