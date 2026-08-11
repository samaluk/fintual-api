import { Context, Effect, Layer } from "effect"
import { FintualConfigService } from "../env.ts"
import { Email2FAFailure } from "./fintual-error.ts"
import {
  Email2FACode,
  ImapClientFactoryLive,
  retrieveEmail2FACode,
  type Email2FAOptions,
} from "./email-2fa/retrieve.ts"

export class Email2FAService extends Context.Service<
  Email2FAService,
  {
    get2FACode: (options: Email2FAOptions) => Effect.Effect<Email2FACode, Email2FAFailure>
  }
>()("Email2FAService") {
  static readonly layer = Layer.effect(
    Email2FAService,
    Effect.gen(function* () {
      const config = yield* FintualConfigService

      return Email2FAService.of({
        get2FACode: Effect.fn("Email2FAService.get2FACode")(function* (options) {
          if (!config.email2FA) {
            return yield* Effect.fail(
              new Email2FAFailure({
                cause: new Error("Fintual email 2FA: Gmail IMAP credentials not configured"),
              }),
            )
          }

          return yield* retrieveEmail2FACode(config.email2FA, options).pipe(
            Effect.provide(ImapClientFactoryLive),
            Effect.catchTags({
              TimedOut: () =>
                Effect.fail(
                  new Email2FAFailure({
                    cause: new Error("Fintual email 2FA: no code received before timeout"),
                  }),
                ),
              Operational: (operational) =>
                Effect.fail(new Email2FAFailure({ cause: operational.cause })),
            }),
          )
        }),
      })
    }),
  )
}
