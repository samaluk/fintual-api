# Email 2FA retrieval is a deep module with typed outcomes

Email 2FA retrieval lives in `src/fintual/email-2fa/` behind a single public entry point: it takes a real `Email2FAConfig` and returns a branded `Email2FACode` or a tagged failure (`TimedOut | Operational`). Disabled 2FA is caller-side configuration, not a module outcome — `http-sync.ts` fails fast when the login requires a code but Gmail credentials are not configured. The module owns the IMAP lifecycle through Effect Scope, the 120-second polling window, mailbox traversal (Gmail mailbox fallback list), search-query fallback, deduplication, parsing policy, and cleanup; a thin operation-level client seam separates the ImapFlow adapter from the module so tests run against a fake client with deterministic polling via Clock/Schedule.

## Status

accepted

## Considered Options

- **`string | null` return (previous design)** — collapsed disabled, timeout, and every operational failure into one value; the consumer reported all three as "no code received before timeout". Rejected: operational failures must remain truthful.
- **Explicit result variant (`code | TimedOut` as a success value)** — rejected because the consumer treats every non-code outcome as a login failure; failure-side typing composes with `catch`/`retry`, and the tagged union lets future callers retry timeouts without folding on a success variant.
- **Disabled handled inside the module** — rejected: configuration assembly is the caller's concern; the module never needs a "disabled" branch.
- **Flat sibling files** — rejected: one entry point per module is the point of the deepening.

## Consequences

- Consumer error messages are now truthful: timeout stays "no code received before timeout"; operational failures carry the IMAP cause.
- Cleanup (logout exactly once, even on interruption) becomes a testable invariant via Scope finalizers observed by the fake client.
- Deterministic timeout and polling tests are possible with the test clock.
- `debug` in `Email2FAConfig` only controls logging; it no longer participates in recoverability decisions.
