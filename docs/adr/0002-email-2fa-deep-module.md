# Email 2FA retrieval is a scoped Effect service

## Status

Accepted

## Context

Email 2FA is a time-bound resource workflow: connect to IMAP, search one or more mailboxes repeatedly, deduplicate messages, extract a valid code, and close the connection on success, failure, timeout, or interruption. A nullable string or a Promise helper cannot describe those semantics truthfully.

## Decision

`Email2FA` is a `Context.Service`. Its public operation accepts only request-specific input, such as the login start time, and returns:

```text
getCode(request): Effect<Email2FACode, Email2FATimedOut | Email2FAOperationalError>
```

The live layer acquires validated email configuration and an `ImapClientFactory`; callers never pass credentials or construct clients. Disabled email 2FA is represented while decoding application configuration and is handled before requiring this service. It is not a retrieval result.

`Email2FACode` is a constrained branded Schema. Public failures are `Schema.TaggedErrorClass` values. Vendor errors are mapped at the IMAP adapter boundary and never escape the service.

The service owns the IMAP client with `Effect.acquireRelease` in a `Scope`. Logout runs exactly once and is uninterruptible. Polling and the overall deadline use `Schedule` and `Clock`; mailbox and query fallback policy remains pure domain logic. The implementation preserves interruption rather than translating it into an operational failure.

The module exports the service contract, request and result schemas, failure union, live layer, and a first-class test layer. IMAP commands, mailbox traversal, MIME parsing, deduplication, and polling mechanics are private.

Tests use `@effect/vitest`, `TestClock`, and a stateful fake service backed by Effect synchronization primitives. They assert timeout, cleanup, interruption, fallback ordering, deduplication, and operational-failure behavior without real sleeps.

## Considered options

- **Return `string | null`** — rejected because it conflates disabled configuration, timeout, malformed mail, and infrastructure failure.
- **Return timeout as a success variant** — rejected because failing to obtain the required code is an expected failure of this operation and composes naturally in the Effect error channel.
- **Pass configuration into `getCode`** — rejected because credentials and provider settings belong to layer construction.
- **Expose a low-level IMAP client to the caller** — rejected because it transfers protocol sequencing and cleanup responsibility out of the module.

## Consequences

- The public method expresses only the domain request and outcomes.
- Connection lifetime and cancellation are correct by construction.
- Timeout and polling behavior are deterministic in tests.
- Changing IMAP libraries affects only the adapter layer.
