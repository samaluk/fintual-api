---
title: 'Fallow audit Action uploads incompatible multi-run SARIF'
severity: 'minor'
target: 'fallow-rs/fallow'
---

## Friction

The pinned Fallow 3.16 Action renders `fallow audit` as a SARIF document with two runs, then uploads the entire file under the single hard-coded `fallow` category. GitHub Code Scanning now rejects this with `does not support uploading multiple SARIF runs with the same category`.

## Impact

Repositories must disable the Action upload, render SARIF from the saved JSON envelope, split the two runs, and upload them under distinct categories. The analysis itself does not need to run twice.
