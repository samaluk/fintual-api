---
title: 'Fallow audit emits invalid dependency entry-pattern warnings'
severity: 'minor'
issue: 'samaluk/fintual-api#331'
---

## Expected Behavior

The documented Fallow audit should run without warnings for valid configuration entries.

## Current Behavior

Every `pnpm fallow:audit` run emits repeated warnings that `pkg.dependencies?.['@actual-app/api']` and `pkg.devDependencies?.['@actual-app/api']` are invalid globs because the bracket contents are parsed as a character range. The audit still succeeds, but the warnings add noise and make it unclear whether the configuration is applied.

## Possible Solution

Escape or otherwise express the dependency-key patterns in the Fallow configuration using syntax accepted by the current Fallow glob parser.

## Minimal Reproducible Example

Run `pnpm fallow:audit` in this repository and observe the repeated invalid entry-pattern warnings before the green audit summary.

## Context

Observed while verifying issue #314 on 2026-08-11. The warning is unrelated to the Effect Schema migration and appears in the existing repository configuration.
