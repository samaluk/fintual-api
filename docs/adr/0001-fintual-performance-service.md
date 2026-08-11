# Fintual ingestion is one Effect Service around the Performance Snapshot

The Fintual sync seam currently exposes intermediate Reference and Recent Goal Performance Data through `createAuthenticatedFintualIngestion`, with login, folding, Effect Schema validation, and inspection-artifact writing composed in a shallow `http-sync.ts` that fails the deletion test; snapshot writes warn instead of failing, and the fold carries dead `null` paths. The design collapses all of it into one deep module, `src/fintual/performance.ts`, exposing a single Effect Service — `FintualPerformance.fetchPerformanceSnapshot(): Effect<PerformanceSnapshot, FintualError>` — with `FintualConfig` provided as a service value and fetch, email 2FA, and snapshot writing as internal services.

`FintualError` is a tagged union that enumerates every failure the public seam can produce, one variant per failure source:

- `UnexpectedHttpStatus { stage, status }` — login/GraphQL responses outside the expected statuses
- `HttpTransportFailure { stage, cause }` — fetch or response-body reads that throw
- `LoginFailed { status }` — 401 on `initiate_login` (wrong credentials)
- `MalformedGoalPerformanceData { purpose, cause }` — malformed JSON, schema mismatch, or GraphQL errors in the reference/recent response
- `MalformedPerformanceSnapshot { issues }` — fold output failing snapshot validation
- `Email2FAFailure { cause }` — no code before timeout, or IMAP retrieval failures
- `SnapshotWriteFailure { cause }` — the inspection artifact could not be written

Folding becomes total (no `null` inputs or outputs; empty arrays surface as `MalformedPerformanceSnapshot`), and write failures fail the sync instead of warning.

## Status

accepted

## Considered Options

- **Plain factory composition (current design)** — `createAuthenticatedFintualIngestion` plus a thin wrapper in `http-sync.ts`; intermediate Reference/Recent Goal Performance Data cross module boundaries and the composition module fails the deletion test. Rejected: the external seam should be the business outcome, a validated Performance Snapshot.
- **Config as a plain argument** — `fetchPerformanceSnapshot(config)` with stateless dependency services. Rejected in favor of config as a service value: the layer requires `FintualConfig` and the email-2FA live impl reads `config.email2FA` from context, so provision-time wiring stays explicit and env.ts remains the only env reader.
- **Untyped `Error` failures** — rejected: a typed `FintualError` union makes every failure mode of the public seam discoverable and testable without reading the module.
- **Warn-and-succeed on write failure (previous behavior)** — rejected: the sync should report when it cannot produce its inspection artifact.
- **Defensive `null` folding** — rejected as dead code; the ingestion never produces null data.

## Consequences

- Callers learn one domain outcome; interval and sequencing knowledge gains locality; the shallow `http-sync.ts` composition module disappears.
- This is the repo's first Effect Service, deliberately module-scoped: Actual sync, email 2FA, and env config keep their plain styles until the repo-wide Effect-native push (#284, #285, #286) decides their shape — this module is the pattern-setting precedent for those.
- The design was settled by `/grill-with-docs` (issue #283); implementation tickets are the follow-up.
