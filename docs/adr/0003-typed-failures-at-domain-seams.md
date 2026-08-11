# Expected failures are Schema-tagged domain values

## Status

Accepted

## Context

Generic `Error` values and third-party rejection types erase the operation that failed, encourage message parsing, and make retry and recovery policies implicit. They also blur the distinction between an expected failure, a defect, and fiber interruption.

## Decision

Every domain or adapter seam maps expected failures into domain-owned `Schema.TaggedError` values. Public failure surfaces are explicit unions and, when they cross a serialization or API boundary, Schema unions.

Failure types follow these rules:

- Tags are stable and domain-qualified where ambiguity is possible.
- Fields carry structured recovery and diagnostic data: operation, stable provider code, status, retryability, identifiers, and `Schema.Defect()` causes as appropriate.
- Adapters classify third-party failures at the first boundary where stable codes or statuses are visible.
- Higher-level services translate lower-level failures only when they can add a truthful domain meaning; otherwise they preserve the typed value.
- Consumers recover with tag-, reason-, or field-based combinators such as `catchTag`, `catchTags`, and `catchIf`. They never inspect rendered messages.
- Retryability is data derived at the adapter boundary, not inferred later from prose.
- Broad cause handling preserves interruption. Expected failures stay in the typed error channel; programmer bugs and violated invariants become defects.
- Expected absence uses `Option` when absence is a valid result, not an exception.
- Public services do not expose plain `Error`, `unknown`, parsing-library failures, SDK errors, or transport-library errors.

There is no shared catch-all application error. Each domain owns the smallest useful taxonomy for its callers. Error rendering and redaction are observability concerns and do not alter error identity.

## Considered options

- **One global error type with a source string** — rejected because it centralizes unrelated domains and weakens exhaustive recovery.
- **Plain errors plus message conventions** — rejected because wording becomes an unstable, hidden control-flow protocol.
- **Wrap every lower-level error at every layer** — rejected because redundant wrapping obscures the original typed failure without adding domain meaning.
- **Catch all causes into expected errors** — rejected because it swallows defects and interruption.

## Consequences

- Service signatures are executable documentation of recoverable failure.
- Recovery, retry, HTTP mapping, and tests use stable structure rather than text.
- Infrastructure libraries can be replaced without changing domain error contracts.
- Adding a new expected failure requires an intentional public type change and exhaustive handling where appropriate.
