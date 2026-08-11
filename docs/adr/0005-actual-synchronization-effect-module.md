# Actual synchronization is a scoped Effect service

## Status

Accepted

## Context

Synchronizing a snapshot to Actual combines filesystem preparation, a health check, SDK resource management, remote reads, reconciliation policy, mutations, final sync, retry, and cleanup. Retrying only part of that sequence or reusing a failed SDK singleton can apply a plan derived from stale state.

## Decision

`ActualSynchronization` is a `Context.Service` exposing one named operation:

```text
synchronize(snapshot): Effect<void, ActualSynchronizationError>
```

Its live layer acquires validated Actual configuration and the `ActualClientFactory`, `ActualFileSystem`, `ActualHealthCheck`, and retry-policy services. The public method has no remaining environment requirements. The application entry point calls this service; no parallel plain-function API is retained.

Each synchronization attempt executes this complete unit:

```text
reset -> health check -> acquire client -> download -> read -> plan
      -> apply mutations -> sync -> release client
```

The client is acquired with `Effect.acquireRelease` inside an attempt-local `Scope`. A retry therefore gets a fresh client, downloads fresh state, and derives a fresh reconciliation plan. The release finalizer is uninterruptible and never leaks a resource. Cleanup failures are recorded through Effect observability without replacing an already meaningful domain failure; the finalizer itself has no typed failure channel.

Reconciliation is pure domain policy over Schema-validated values. Its action algebra uses exhaustive tagged variants. Imported identifiers make recovery after an ambiguous mutation response idempotent on the next full attempt.

Adapters map SDK, filesystem, and HTTP failures to operation-specific `Schema.TaggedError` values and attach structured retryability derived from stable codes and status classes. The orchestration layer never parses messages. The health adapter uses Effect `HttpClient`, including cancellation and timeout.

Retry wraps the entire scoped attempt. A bounded `Schedule` supplies capped exponential backoff, jitter, retry logging, and the attempt limit. Only failures classified as retryable enter the schedule, and only because the complete attempt is safe to repeat. Dates, timeout, backoff, and jitter use Effect `DateTime`, `Clock`, and `Random` services.

Tests use the service with explicit fake layers and deterministic `TestClock`/`TestRandom` control. They assert the attempt boundary, fresh acquisition, finalization, retry cap, backoff, idempotent reconciliation, and non-retryable short circuit.

## Considered options

- **Manual recursion around a shared SDK singleton** — rejected because it couples lifecycle and retry policy and can reuse contaminated state.
- **Retry only the failed SDK call** — rejected because the reconciliation plan may already be stale or the remote mutation may have succeeded despite a lost response.
- **Pass adapters and configuration as function arguments** — rejected because they are service implementation dependencies supplied by layers.
- **Classify failures from messages in orchestration** — rejected because message text is neither stable nor domain-owned.

## Consequences

- The retry boundary matches the consistency boundary.
- Every attempt has isolated resource lifetime and freshly derived state.
- The workflow is testable end to end without a live Actual server, filesystem, real clock, or process environment.
- Vendor and platform details remain in replaceable leaf layers while reconciliation stays pure.
