---
title: 'Fallow audit rejects valid dependency entry patterns'
severity: 'minor'
---

## Expected Behavior

The Fallow audit should parse the repository dependency entry patterns without warnings.

## Current Behavior

pnpm fallow:audit emits repeated warnings that the configured patterns pkg.dependencies?.[at-actual-app-api] and pkg.devDependencies?.[at-actual-app-api] are invalid globs, even though the audit continues.

## Possible Solution

Update the Fallow configuration to use syntax accepted by the current Fallow version.

## Minimal Reproducible Example

Run pnpm fallow:audit from a clean checkout of origin/main.

## Context

Observed while verifying issue 316 on origin/main at ce7800f.
