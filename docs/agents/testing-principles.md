# Testing principles

This codebase favors small, readable test suites with explicit setup and minimal magic. A test should exercise a meaningful behavior from setup through outcome, even when that produces a longer test with several related assertions.

These principles are adapted from [Kody's testing principles](https://github.com/kentcdodds/kody/blob/main/docs/contributing/testing-principles.md) for this repository.

## Choose the test boundary

Use the narrowest boundary that can reliably disprove the behavior under test:

- Test pure domain logic without I/O when the behavior does not depend on an external system.
- Use an integration test when the behavior depends on module boundaries, persistence, email parsing, or an external API contract. Prefer controlled in-memory collaborators such as a scripted `fetch` implementation when the network itself is not under test.
- Reserve end-to-end tests for a small number of critical journeys that genuinely require the assembled application.

Do not replace an important boundary with mocks when the integration itself is what needs confidence. Conversely, do not pay the cost of integration or end-to-end setup for behavior a focused test can cover honestly.

## Colocate tests with their implementation

Place each `*.test.ts` file beside the module it covers, following the pattern used in [Kody's `tools` directory](https://github.com/kentcdodds/kody/tree/main/tools). Do not create a separate directory that makes readers navigate away from the implementation to find its tests.

For example:

```text
src/fintual/
├── performance.ts
├── performance.test.ts
├── provider.ts
└── provider.test.ts
```

Cross-system end-to-end tests may use a dedicated directory when no single implementation module is their natural owner.

## Write workflow-oriented tests

- Treat a test like a manual tester's script: establish the state, perform the actions, and assert the observable results.
- Keep related assertions in the same test when they describe one workflow. Multiple assertions are useful when they make the behavior and intermediate outcomes clear.
- Prefer fewer complete tests over many tiny tests that repeat the same setup.
- Keep test names behavioral and specific, for example: `rejects a transaction email when the amount is missing`.
- Prefer flat Vitest files. Use a single `describe` level only when closely related variants become easier to scan together.
- Keep setup local to the test. Use shared factories for readability, but avoid hooks and mutable globals that hide preconditions or couple cases together.
- Return ready-to-use values from test helpers instead of changing ambient state.

## Assert durable behavior

- Assert user-visible outcomes, domain results, and stable public contracts.
- Avoid assertions that merely pin implementation details, incidental log messages, or prose.
- Do not test guarantees already enforced by the type system.
- For a regression test, reproduce the failure at the lowest honest boundary and assert the corrected behavior. Add one when the failure is plausible enough, or the affected journey important enough, to justify its maintenance cost.
- Keep fixtures as small and representative as possible. Make important values visible in the test rather than burying them in a large shared fixture.

## Assert redacted rendering

When testing a secret's safe rendering, assert that `String(redacted)` returns
`"<redacted>"`, as in [the runtime configuration tests](../../src/env.test.ts).
This protects the rendering contract; inspecting the underlying value alone
does not verify that stringification hides the secret.

Oxlint 1.88.0 reports `typescript/no-base-to-string` for Effect's `Redacted`
values even though they intentionally render a safe placeholder. Keep the
assertion and suppress only that line, with a short explanation:

```ts
// Redacted intentionally exposes a safe placeholder through String().
// oxlint-disable-next-line typescript/no-base-to-string
expect(String(configuration.actual.password)).toBe("<redacted>")
```

The lint script's `--report-unused-disable-directives` reports obsolete
suppressions when the rule starts recognizing this behavior. Remove the
suppression then and retain the assertion.

## Keep tests deterministic

- Tests must run offline unless access to a third-party system is the explicit subject of an opt-in integration test.
- Replace clocks, randomness, and generated identifiers with controlled inputs when their values affect assertions.
- Give each test isolated state. Never rely on execution order or state left by another test.
- Use temporary resources only when the behavior requires them, and clean them up even when an assertion fails.
- Do not solve flakiness with retries, sleeps, or relaxed assertions. Remove the uncontrolled dependency instead.

## Maintain a high signal-to-cost ratio

- Prefer fast tests for domain logic and reserve slower suites for boundary confidence.
- Avoid duplicate coverage across layers unless each layer protects a distinct risk.
- A test should fail for a meaningful behavioral regression, not harmless refactoring.
- Keep output quiet. Expected errors should be captured and asserted; unexpected warnings and errors should remain visible.

## Testing lint rules

Of the Landmines plugins, Oxlint loads only `@interfere/landmines/testing`.
The `no-test-doubles`, `strict-msw`, `no-fixed-sleep`, `no-unsignaled-poll`,
and `no-flake-masking` rules are errors. The Landmines style and type-annotation rules are not
enabled; the existing built-in TypeScript lint rules remain enabled.

There are no grandfathered Landmines violations. HTTP scenarios use strict MSW
handlers with the real FetchHttpClient. Actual synchronization tests control
the application-level client to test retries and interruption. SDK compatibility
tests instead generate one immutable SQLite-backed archive with accounts for
the different fixture cases. Each test downloads it into its own data directory
and exchanges Actual's binary sync messages with its own loopback server.
The server implements only the unencrypted endpoints used by these tests; it
uses Actual's CRDT package to accept changes and replay them to a fresh SDK
client, not to emulate the SDK's database or reconcile logic. The suite sets
`NODE_ENV=production` in its isolated test worker so the SDK uses its normal
deferred sync path instead of syncing inline on each mutation. The seed marks
the SDK's daily schedule runner as already run at a fixed SDK date; otherwise it
can write preferences in the background after shutdown. The malformed-row case
seeds a SQLite blob because public SDK writes accept only a string imported ID.

The `@actual-app/crdt` pnpm patch only corrects relative ESM declaration imports
for TypeScript's `NodeNext` resolution. Remove it when the pinned release ships
resolvable declarations; it does not change the runtime protocol implementation.

## Running tests

Vitest is the test runner. Run the complete suite with:

```sh
pnpm test
```

During development, pass a file path through the package script to run a focused test file:

```sh
pnpm test src/fintual/performance.test.ts
```

The pre-push hook runs the complete project checks. Do not run these commands
routinely before handoff; run an individual command when diagnosing a hook
failure or when explicitly requested:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm fallow:ci
```
