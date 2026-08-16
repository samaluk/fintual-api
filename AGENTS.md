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
  fixes, and re-stages the fixed files; it also runs a fast Fallow audit of the
  staged changes.
- `pre-push` runs Oxfmt, Oxlint, TypeScript, tests with coverage, and the full
  Fallow ratchet (`pnpm fallow:ci`).

Only run an individual check outside the hooks when diagnosing a reported hook
failure or when the user explicitly asks for it. Focused tests are still
appropriate when they directly support development or diagnosis.

### Fallow

The version-matched Fallow agent skill is vendored at `.agents/skills/fallow`
(regenerate with `pnpm fallow:skill:sync` after a fallow upgrade). The
repository runs Fallow as a strict quality ratchet — full policy and command
surface in `docs/fallow.md`. Use it when:

- **About to delete an "unused" export, file, or dependency** — trace first:
  `pnpm exec fallow dead-code --trace <file>:<export>` or
  `pnpm exec fallow dead-code --trace-dependency <name>`, and confirm exact
  consumers with `pnpm exec fallow dead-code --type-aware --symbol-impact <file>:<export>`.
- **Before committing or opening a PR** — run `pnpm fallow:audit` (changed-code
  gate) or `pnpm fallow:ci` (full ratchet) when the hooks did not cover your
  change.
- **Prioritizing refactors** — `pnpm exec fallow health --hotspots --targets`.
- **Investigating a finding** — `pnpm exec fallow explain <issue-type>` and
  `pnpm exec fallow inspect --file <path>`.
- **Checking architecture rules before editing** — `pnpm exec fallow guard <files>`.

Exit codes: 0 = clean, 1 = findings found (analysis succeeded), 2 = real
analyzer/config error. Do not treat exit 1 as infrastructure failure. Baselines
in `fallow-baselines/` are a one-way ratchet: fix code, then run
`pnpm fallow:baseline:update`; never regenerate a worse baseline to silence CI.

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
