---
title: 'Fallow dupes ignores --fail-on-issues and treats threshold zero as disabled'
severity: 'major'
target: 'fallow-rs/fallow'
---

## Expected Behavior

The documented global --fail-on-issues flag should reject every unignored clone group, as required by this repository zero-debt policy.

## Current Behavior

Fallow 3.26 standalone dupes and combined analysis both report semantic and near clone groups but exit 0 with --fail-on-issues. This reproduces in human and JSON formats. A threshold of zero disables threshold gating instead of rejecting any duplication. The same gate logic is present in the 3.27 source.

## Possible Solution

Honor --fail-on-issues for clone groups. The native percentage gate works with a strictly positive threshold; the smallest positive f64 (5e-324) rejects any positive measurable duplication without adding percentage headroom.

## Minimal Reproducible Example

Create two used modules exporting identical functions of at least 8 lines and 60 tokens. Configure semantic mode, near detection and minOccurrences: 2. Disable duplicate-exports in this isolated fixture so that an unrelated finding cannot mask the duplication verdict. fallow dupes --fail-on-issues reports two groups and exits 0; setting duplicates.threshold to 5e-324 changes the exit to 1.

## Context

Discovered while reviewing whether the four-command gate can be consolidated. The current full-repository duplication gate was already inert; changed-file audit still caught clones in edited files.
