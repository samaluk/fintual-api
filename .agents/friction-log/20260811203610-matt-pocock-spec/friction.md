---
title: 'Matt Pocock spec flow never closes the parent spec after its tickets land'
severity: 'minor'
issue: 'samaluk/fintual-api#370'
---

## Expected Behavior

The parent spec issue closes once every child ticket it produced is closed:
through its merged PR when the work ships, or explicitly when all children
are closed without landing.

## Current Behavior

The to-spec -> to-tickets -> implement flow closes each child ticket through its PR, but nothing closes the parent spec when all children are done. Example: #351 had all three children (#352, #353, #354) closed by merged PRs (#355, #356, #362) and remained open.

## Possible Solution

Document a spec lifecycle in docs/agents/issue-tracker.md and docs/agents/delivery-workflow.md, teach the final ticket PR to include Closes #spec, and add a parent-closure sweep to ask-matt-chain's session protocol.

## Minimal Reproducible Example

Run to-spec then to-tickets for a feature, implement and merge every child PR, then list open issues: the spec remains open.

## Context

Specs are plans, not backlog items; leaving them open makes ready-for-agent queries mix stale plans with actionable tickets.
