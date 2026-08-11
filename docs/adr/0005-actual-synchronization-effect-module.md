# Actual synchronization is a scoped Effect workflow

Actual synchronization exposes one application-facing operation:
`ActualSynchronization.synchronize(snapshot)`. The process entrypoint keeps its
existing `main(config, snapshot)` shape and only provides the configuration and
live layers needed by that service.

The Actual SDK singleton is an adapter behind `ActualClientFactory`. Each
Synchronization Attempt acquires the client in an Effect `Scope` and releases
it exactly once through `shutdown`, including failure and interruption paths.
Filesystem reset and the `/health` request are separate adapters so tests can
replace production filesystem and network behavior without touching the
workflow.

The retryable unit is the complete Synchronization Attempt:

```text
reset → health check → initialize → download budget → read state → plan
      → apply mutations → sync → shutdown
```

Every retry acquires a fresh client and re-derives the Reconciliation Plan from
freshly downloaded state. Imported ids make a mutation whose response was lost
safe to reconcile on the next attempt.

Expected Actual failures are tagged errors. The adapters preserve the original
cause and compute a `retryable` field from stable Actual error codes or HTTP
status classes. The orchestration layer never classifies failures by message.
Effect `Schedule` supplies the five-attempt cap, capped exponential backoff,
jitter, Clock/Random integration, and retry logging. Current-date lookup uses
Effect `DateTime` so workflow tests can control it with `TestClock`.

## Status

accepted

## Considered Options

- **Manual recursive retry around the SDK singleton** — rejected: it kept
  lifecycle, retry policy, and failure classification coupled and reused a
  potentially dirty singleton across attempts.
- **A single shared Actual error with an operation field** — rejected: the
  domain convention calls for discoverable failure variants at meaningful
  operation boundaries.
- **Passing production dependencies as ordinary function arguments** —
  rejected: Effect services and Layers keep the public synchronization seam
  small while making deterministic workflow adapters explicit.

## Consequences

- The Actual workflow can be tested end-to-end through one service method.
- Shutdown, retry limits, backoff, and health-check timeout behavior are
  observable without a live Actual server.
- The SDK remains an external singleton, but its lifetime is bounded to one
  attempt and never leaks into the reconciliation policy.
