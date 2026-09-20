---
title: 'Fallow combined JSON reports findings but exits zero with --fail-on-issues'
severity: 'minor'
target: 'fallow-rs/fallow'
---

## Expected Behavior

An explicitly armed --fail-on-issues gate should reject findings independently of output format.

## Current Behavior

Fallow 3.26 combined analysis exits 0 with --format json --fail-on-issues for unused exports/files, warning dependency findings, private type leaks, stale suppressions, boundary violations, complexity and CRAP findings. The same run with --format human exits 1. Missing coverage and incomplete type-aware evidence still fail in both formats. Upstream combined/output.rs explicitly preserves this machine-renderer behavior. Duplication additionally needs a positive threshold, recorded separately.

## Possible Solution

Make the explicit findings gate independent of rendering. Until then, pin --format human on a combined blocking CLI command; do not infer a clean result from a JSON-mode exit code.

## Minimal Reproducible Example

Create main.ts with an unused exported constant, configure it as an entry with includeEntryExports: true, then compare fallow --format json --fail-on-issues with fallow --format human --fail-on-issues.

## Context

Found while simplifying the Fintual API zero-debt gate after reviewing the changes since Fallow 3.17. The missing-tsconfig blocker is fixed, but the combined CLI gate needs an explicit output format.
