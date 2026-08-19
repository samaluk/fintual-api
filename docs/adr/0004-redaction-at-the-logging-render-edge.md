# Redaction is enforced by an Effect logger layer

## Status

Accepted

## Context

Credentials, tokens, account identifiers, and email addresses can appear in messages, causes, annotations, or third-party failures. Call-site sanitization alone is incomplete because every new logging path becomes another security boundary.

## Decision

All application logs use Effect logging. The application composition root installs one custom `Logger` layer before running the program with `NodeRuntime.runMain`. The logger applies redaction to the fully rendered event, including message values, cause output, spans, and annotations.

The redaction policy is an internal capability of the `RedactingLogger` layer built from validated runtime configuration. It is immutable for the lifetime of the application runtime; the design does not use a mutable module-global registry. Secrets remain `Redacted` in application configuration. Plaintext access is confined to the external adapter that must send a secret and to the redaction layer that must recognize it; domain and orchestration code never reveal it. The logger's policy is initialized with all values that must be suppressed before application work starts.

Domain errors retain structured evidence and original causes. Redaction changes only rendering, never error construction, tags, retry classification, or program control flow. Adapters must still avoid logging entire request headers, cookies, credentials, or private response bodies.

The process entry point is intentionally thin: load the `ConfigProvider`, construct the application and logger layers, provide them once, and invoke `NodeRuntime.runMain`. Runtime-reported terminal failures pass through the same logger. Application modules do not call `console`, format terminal failures independently, or maintain a second redaction mechanism.

Human-readable output may remain a configured logger format for the cron environment; the event data and redaction policy stay independent of that renderer so a structured sink can replace it without changing domain code.

## Considered options

- **Sanitize only while constructing errors** — rejected because causes, annotations, and future logging sites can bypass it.
- **Maintain a mutable global set of discovered secrets** — rejected because it introduces hidden process state, ordering dependence, and test isolation problems.
- **Discard causes before logging** — rejected because it removes essential diagnostics instead of securing their rendering.
- **Let `NodeRuntime` print failures separately** — rejected because it creates an unredacted output path.

## Consequences

- Every Effect log event and terminal failure crosses one redaction boundary.
- Tests provide an isolated policy/logger layer and cannot leak redaction state across cases.
- Error models remain useful for diagnosis without coupling domain construction to presentation policy.
- Adding a new sensitive configuration value requires updating the redaction-policy layer before that value can be logged safely.
