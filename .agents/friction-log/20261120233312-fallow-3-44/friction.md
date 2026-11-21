---
title: 'Fallow 3.44 config resolves policy without a --resolved flag'
severity: 'minor'
target: 'fallow-rs/fallow'
---

Setup verification requested `pnpm exec fallow config --resolved`, but 3.44.0 rejects the flag with exit 2. `pnpm exec fallow config --help` documents that bare `config` already resolves extends and emits final JSON. Used bare config for before/after policy comparison; documented the version-specific command.
