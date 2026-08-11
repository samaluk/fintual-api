## Agent skills

### Learning more about the Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

### Issue tracker

Issues and specs are tracked in GitHub Issues for `samaluk/fintual-api`. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.

### Testing principles

Tests favor readable, behavior-focused workflows with explicit setup. See `docs/agents/testing-principles.md`.

### Delivery workflow

Plan commits, run diagnostic probes, verify changes, and publish issues and PRs
according to `docs/agents/delivery-workflow.md`.

### Verification

Do not routinely run typechecks, Fallow, formatting, linting, or the full test
suite while working or before handing off a change. The Git hooks are the
verification boundary:

- `pre-commit` checks staged TypeScript with Oxfmt and Oxlint, applies safe
  fixes, and re-stages the fixed files.
- `pre-push` runs Oxfmt, Oxlint, TypeScript, tests, and Fallow.

Only run an individual check outside the hooks when diagnosing a reported hook
failure or when the user explicitly asks for it. Focused tests are still
appropriate when they directly support development or diagnosis.

### Friction logging

Friction is logged with Frog (see https://frog.fm). Use `pnpx frog log` to write an entry, and `pnpx frog list` first to see what is already known.

- Log papercuts and friction (tooling, docs, APIs, tests, conventions) as you hit them with `pnpx frog log`.
- Do not add global, system, or internal friction.
- Run `pnpx frog list` first to see what is already known.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for
reference. Use this to explore APIs, find usage examples, and understand
implementation details when the documentation isn't enough.
