## Agent skills

### Learning more about the Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

### Issue tracker

Issues and specs are tracked in GitHub Issues for `samluk/fintual-api`. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.

### Testing principles

Tests favor readable, behavior-focused workflows with explicit setup. See `docs/agents/testing-principles.md`.

### Friction logging

Friction is logged with Frog (see https://frog.fm). Use `pnpx frog log` to write an entry, and `pnpx frog list` first to see what is already known.

- Log papercuts and friction (tooling, docs, APIs, tests, conventions) as you hit them with `pnpx frog log`.
- Do not add global, system, or internal friction.
- Run `pnpx frog list` first to see what is already known.
