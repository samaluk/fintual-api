---
title: 'Fallow audit emits invalid glob warnings for package keys'
severity: 'minor'
issue: 'samaluk/fintual-api#330'
---

## Expected Behavior

`pnpm fallow:audit` completes without unrelated configuration warnings.

## Current Behavior

The audit completes successfully but emits repeated warnings that `pkg.dependencies?.['@actual-app/api']` and the analogous `devDependencies` pattern are invalid glob ranges.

## Possible Solution

Update the Fallow entry patterns for package keys so the Actual dependency keys parse without warnings.

## Minimal Reproducible Example

1. Run `pnpm fallow:audit` in the repository.
2. Observe the invalid range warnings before the audit summary.
3. Observe that the audit still passes.

## Context

Discovered while implementing issue #286 on 2026-08-11. The warning is repository-local tooling noise and does not affect the Actual synchronization implementation.
