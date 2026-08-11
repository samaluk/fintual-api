# Effect-first application architecture

## Status

Accepted

## Context

This is a greenfield application. Compatibility with earlier internal APIs is not a design goal, so transitional wrappers, mixed Promise/Effect application code, and legacy dependency-passing styles would add complexity without protecting a supported consumer.

Effect is therefore the application architecture, not a utility used around selected operations. The design should preserve Effect's typed error, dependency, resource, concurrency, configuration, observability, and testing models from the process entry point down to external adapters.

## Decision

All application workflows are Effect programs. Domain capabilities and external adapters are `Context.Service` contracts implemented by `Layer`s. A single application layer graph is assembled at the composition root and provided once before `NodeRuntime.runMain`.

The following rules govern every other ADR:

- Public service methods have an `R` type of `never`; implementation dependencies are acquired while constructing the service layer.
- Real implementations default to `Layer.effect(Service, Effect.gen(...))` and return `Service.of({ ... })`. Constructors such as `Layer.succeed`, `Layer.sync`, and `Layer.scoped` are used when their semantics are more accurate.
- Public and non-trivial internal operations use named `Effect.fn` functions. Multi-step workflows use `Effect.gen`.
- Runtime configuration is decoded with `Config` in layers. Secrets use `Redacted`; application logic does not read `process.env` or mutate global configuration.
- Records and boundary contracts use `Schema.Struct` with same-name interfaces. Scalar identifiers use constrained branded schemas. Unknown HTTP, file, and SDK data is decoded with `Schema.decodeUnknownEffect` at the owning boundary.
- Expected failures use domain-owned `Schema.TaggedErrorClass` values. Defects, interruption, and expected failures remain distinct. Public services do not expose plain `Error`, third-party error types, or message-text classification.
- External HTTP uses Effect `HttpClient`. Each adapter owns request construction, authentication, status classification, response decoding, cancellation, and domain-error mapping.
- Resources use `Scope`, `Effect.acquireRelease`, or the corresponding scoped layer constructor. Background work is forked into its owning scope and never outlives that scope.
- Retry, repetition, polling, timeout, and pacing use `Schedule`, `Clock`, and the relevant Effect combinators. Retry is bounded and limited to operations proven safe to repeat.
- Collections over time use `Stream` when pull, backpressure, interruption, or incremental consumption matters. `Queue`, `PubSub`, `Deferred`, `Latch`, and `Ref` are preferred over ad-hoc concurrency state.
- Application logging uses Effect logging and a logger layer. Direct console output is limited to tooling that is outside the application runtime.
- Tests use `@effect/vitest`, explicit test layers, `ConfigProvider`, `TestClock`, and deterministic synchronization. Tests do not mutate process globals or wait with real sleeps.

Modules expose the smallest domain capability that callers need. Leaf adapters remain replaceable services, while orchestration and policy remain free of platform and vendor APIs. Compatibility shims and duplicate legacy entry points are removed rather than retained.

## Considered options

- **Use Effect only for error handling and retries** — rejected because it creates two execution and dependency models and loses typed requirements at their boundary.
- **Keep Promise-based domain APIs and run Effect internally** — rejected because cancellation, scope, typed errors, and service requirements disappear from the public contract.
- **Preserve legacy factories and aliases during migration** — rejected because this project has no compatibility requirement and the extra surface would become accidental architecture.

## Consequences

- The type of each program describes its success, expected failure, and remaining service requirements.
- Resource lifetime, cancellation, configuration, logging, and tests share one runtime model.
- Replacing an adapter means replacing a layer, not changing domain workflows.
- Effect-unsafe convenience code is treated as architectural drift even when it appears locally simpler.
- Unstable Effect modules may be used deliberately in this greenfield codebase; upgrades update the adapter rather than preserving a parallel legacy abstraction.
