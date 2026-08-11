# Redaction at the logging render edge

Credentials and email addresses must never appear in job output. Previously redaction ran inside the `effect.ts` aliases at error-message creation, coupling message building to the redaction policy and leaving any code path that bypassed the aliases unprotected. We keep `src/log.ts` as the redaction policy module, and the `once.ts` process edge renders all logs through a custom `Logger` (installed on `NodeRuntime.runMain`, which adds `@effect/platform-node`) that redacts message, cause, and annotation values at render time; creation-time redaction via `getErrorMessage` is retained as belt-and-suspenders during the transition. Output is deliberately upgraded from bare `console.log` lines to timestamped, level-prefixed plain-text lines, since the logs are human-read from cron.

Considered and rejected: creation-time-only redaction (every call site becomes a leak boundary), and no redaction integration (secrets in logs).
