import { Redacted } from "effect"

import type { RuntimeConfig } from "./env.ts"

export const secret = "hunter2-super-secret"
export const fintualSecret = "fintual-pass"
export const email2FASecret = "app-password"

export const runtimeConfig: RuntimeConfig = {
  actual: {
    serverUrl: "http://localhost:5006",
    password: Redacted.make(secret),
    syncId: "sync-1",
    fintualAccount: "fintual-account",
    startingDate: "2024-03-01",
    payee: "Fintual",
  },
  fintual: {
    email: "user@example.com",
    password: Redacted.make(fintualSecret),
    goalId: "goal-42",
    email2FA: {
      userEmail: "2fa@example.com",
      appPassword: Redacted.make(email2FASecret),
      host: "imap.gmail.com",
      port: 993,
      debug: false,
      sender: "notificaciones@fintual.com",
    },
  },
}
