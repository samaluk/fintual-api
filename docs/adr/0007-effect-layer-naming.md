# Effect service layer naming

## Status

Accepted

## Context

Effect service modules expose one or more `Layer`s that a composition root wires
together. The meaning of a layer's name has been implicit: `FintualProvider.layer`
requires configuration and self-provisions its HTTP transport, while
`ActualRetryPolicy.live` is a self-contained `Layer.succeed`. Reviewers have
enforced the distinction without a written rule, so each one applies their own
reading, and the codebase has drifted — `SnapshotWriter.layer` is a
self-contained `Layer.sync`, the same shape as `ActualRetryPolicy.live`, named
differently. This friction recurs on every new module.

## Decision

An Effect service module uses two static layer constructors:

- **`.layer`** — construction. The layer may require dependencies from the
  environment (config services, adapters, the Effect `HttpClient`) or take
  configuration as an argument.
- **`.live`** — composition-ready. The layer provides every module-internal
  dependency (adapters, sub-services, transport) so the composition root supplies
  only the app-level config services (`ActualConfigService`,
  `FintualConfigService`).

When a module needs both, `.live` composes `.layer`:

```text
static readonly layer = Layer.effect(Service, ...)
static readonly live = this.layer.pipe(Layer.provide(<internal dependencies>))
```

Apply the rule by answering one question: does the layer need anything from the
environment?

- **Yes** — a single layer requiring config, adapters, or the `HttpClient` is
  `.layer`. `FintualProvider.layer`, `ActualHealthCheck.layer`. A layer that
  takes configuration as an argument is also `.layer` (`RedactionPolicy`).
- **No** — a fully self-contained layer with no environment requirements is
  `.live`, including `Layer.succeed` and `Layer.sync` layers.
  `ActualRetryPolicy.live`, `ActualClientFactory.live`, `ActualFileSystem.live`.
- **Both** — `.layer` builds from dependencies; `.live` wires them:
  `ActualSynchronization`, `Email2FAService`, `FintualPerformance`.

Layer constants are statics on the service class. Top-level exported `...Live`
constants are not used (`ImapClientFactory.live`, not `ImapClientFactoryLive`).

## Considered options

- **Name every layer `.live`** — rejected: it erases the construction/composition
  distinction and makes config-requiring layers look fully wired.
- **Keep a separate `.test` layer convention** — rejected: test layers already
  use direct `Effect.provideService` at the call site; no new name is needed.
- **Document the convention without converging the codebase** — rejected: a norm
  that existing code contradicts invites the same drift. `SnapshotWriter` and
  `ImapClientFactory` were renamed as part of this ADR.

## Consequences

- New modules pick a name mechanically: environment requirements present → `.layer`,
  absent → `.live`.
- Reviewers apply the rule instead of re-deriving it.
- `SnapshotWriter.layer` and `ImapClientFactoryLive` were renamed to `.live`
  statics when this ADR landed; future deviations are fixed under this ADR.
