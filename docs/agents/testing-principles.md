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
├── authenticated-ingestion.ts
├── authenticated-ingestion.test.ts
├── new-performance.ts
└── new-performance.test.ts
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

## Running tests

Vitest is the test runner. Run the complete suite with:

```sh
pnpm test
```

During development, pass a file path through the package script to run a focused test file:

```sh
pnpm test src/fintual/new-performance.test.ts
```

Before publishing a change, run the complete project checks:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm fallow:ci
```
