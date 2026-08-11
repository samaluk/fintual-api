---
title: 'oxlint rejects intentional String(Redacted) behavior assertions'
severity: 'minor'
---

## Expected Behavior
Tests should be able to assert Effect Redacted values render as the documented <redacted> placeholder.

## Current Behavior
The lint hook flags String(redacted) with typescript/no-base-to-string even though Effect documents String() as the safe placeholder rendering.

## Possible Solution
Recognize Redacted values in the no-base-to-string rule, or document the targeted disable needed for this API.

## Minimal Reproducible Example
Run the repository lint hook on a test containing String(Redacted.make("secret")).

## Context
Tests need targeted oxlint-disable comments to cover the redaction rendering contract.
