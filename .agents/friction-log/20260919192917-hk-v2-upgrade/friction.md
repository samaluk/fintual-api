---
title: 'hk v2 upgrade guide omits structured builtin prefix migration'
severity: 'minor'
target: 'jdx/hk'
---

## Expected Behavior

The v2 migration guide covers the prefix change needed when amending builtins that now use structured argv commands.

## Current Behavior

After updating the Config.pkl and Builtins.pkl imports from 1.54.1 to 2.0.1, hk config dump rejects the existing Oxfmt step with: Step oxfmt cannot combine structured argv commands with a shell prefix. The migration guide does not mention this transition.

## Reproduction

Amend Builtins.oxfmt with prefix = "pnpm exec", then load that configuration in hk 2.0.1.

## Workaround

Use prefix = List("pnpm", "exec") for Oxfmt and Oxlint. Applied in the fintual-api hk v2 migration.
