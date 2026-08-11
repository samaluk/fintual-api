import { Context, Effect, Layer } from "effect"
import type { Email2FAConfig } from "../env.ts"
import {
  Email2FACode,
  ImapClientFactoryLive,
  Operational,
  retrieveEmail2FACode,
  TimedOut,
  type Email2FAOptions,
} from "./email-2fa/retrieve.ts"

export class Email2FAService extends Context.Service<
  Email2FAService,
  {
    get2FACode: (
      config: Email2FAConfig,
      options: Email2FAOptions,
    ) => Effect.Effect<Email2FACode, TimedOut | Operational>
  }
>()("Email2FAService") {
  static readonly layer = Layer.succeed(
    Email2FAService,
    Email2FAService.of({
      get2FACode: Effect.fn("Email2FAService.get2FACode")(function* (config, options) {
        return yield* retrieveEmail2FACode(config, options).pipe(
          Effect.provide(ImapClientFactoryLive),
        )
      }),
    }),
  )
}
