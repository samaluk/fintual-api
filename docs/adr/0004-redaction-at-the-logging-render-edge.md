# Redaction at the logging render edge

Credentials and email addresses must never appear in job output. Redaction currently runs while error messages are created, coupling message construction to the policy and leaving any logging path that bypasses the aliases unprotected. Keep `src/log.ts` as the redaction policy module, and install a custom `Logger` at the `once.ts` process edge through `NodeRuntime.runMain` from `@effect/platform-node`. The logger redacts message, cause, and annotation values when it renders every log event. Retain creation-time redaction through `getErrorMessage` during the domain migration as an additional safeguard.

The rendered output is timestamped, level-prefixed plain text because the cron output is read by humans.

## Status

accepted

## Considered Options

- **Creation-time-only redaction** — rejected because every call site becomes a possible leak boundary.
- **No logger integration** — rejected because causes and annotations can contain secrets even when the main message has already been sanitized.
- **Structured JSON output** — rejected for now because the job output is consumed directly by humans rather than a log ingestion system.

## Consequences

- All Effect logs cross one redacting render edge before reaching process output.
- `src/log.ts` remains the policy module and keeps its current configuration API; #285 does not introduce a new configuration service.
- `once.ts` uses `NodeRuntime.runMain`, preserving the runtime's standard exit behavior while reporting unhandled failures through the logger.
