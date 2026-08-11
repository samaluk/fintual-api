# Fintual performance ingestion is one Effect service

## Status

Accepted

## Context

Callers need a validated `PerformanceSnapshot`, not login steps, GraphQL payloads, cookie handling, fold inputs, or inspection-file mechanics. Exposing those intermediate concepts would leak provider protocol into the application workflow and force callers to coordinate resource lifetime and failure mapping.

## Decision

`FintualPerformance` is a `Context.Service` exposing one named operation:

```text
fetchPerformanceSnapshot(): Effect<PerformanceSnapshot, FintualError>
```

Its live layer acquires validated Fintual configuration, an Effect `HttpClient`-backed session adapter, `Email2FA`, and `SnapshotWriter`. The method itself has no remaining environment requirements.

The module owns the complete workflow: establish a scoped authenticated session, perform login and optional email 2FA, fetch reference and recent performance data, decode both responses with Schema, fold them into the domain model, validate the final snapshot, and persist the inspection artifact.

The HTTP adapter owns cookies, authentication headers, cancellation, status classification, body decoding, and transport-error mapping. Provider calls never use raw `fetch` in the domain service. Intermediate provider DTOs remain private to the adapter/module.

`FintualError` is a Schema union of domain-owned `Schema.TaggedError` variants covering authentication rejection, transport failure, unexpected provider response, malformed provider data, invalid folded snapshot, email 2FA failure, and snapshot persistence failure. Each variant carries structured diagnostic fields and a `Schema.Defect()` cause when appropriate. Message strings are not control-flow APIs.

Empty or malformed provider datasets fail explicitly. Folding is total over validated inputs and does not accept defensive `null` states that the boundary cannot produce. Failure to write the required inspection artifact fails the operation.

All public and non-trivial internal operations use stable `Effect.fn` names. Runtime configuration is obtained by the live layer from Effect `Config`; credentials remain `Redacted` until the HTTP adapter uses them.

## Considered options

- **Expose login and GraphQL operations to callers** — rejected because it leaks protocol sequencing and weakens the domain seam.
- **Keep a plain factory around raw `fetch`** — rejected because Effect `HttpClient` provides the native cancellation, layers, transforms, status handling, and schema decoding this application requires.
- **Pass configuration into every call** — rejected because configuration is an implementation dependency of the live layer, not domain input.
- **Return third-party or generic errors** — rejected because callers need a closed, discoverable failure surface.
- **Warn when the artifact write fails** — rejected because the operation promises both the validated snapshot and its required inspection artifact.

## Consequences

- Callers depend on one business outcome and one typed failure union.
- Provider protocol and raw payloads cannot spread into orchestration code.
- Tests replace the leaf layers and exercise the complete service workflow without network, filesystem, environment, or real-time dependencies.
- Provider contract changes are localized to schemas and the HTTP adapter.
