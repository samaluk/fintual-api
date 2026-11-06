---
title: 'Fallow 3.40.0 treats shell control keywords as unlisted package binaries'
severity: 'minor'
target: 'fallow-rs/fallow'
---

In samaluk/fintual-api PR #706, upgrading Fallow from 3.39.0 to 3.40.0 makes the canonical --fail-on-issues gate fail on the prepare script `if [ -x node_modules/.bin/effect-tsgo ]; then effect-tsgo patch --typescript --force; fi`. The unlisted-binaries rule reports if, then, and fi as package binaries, although all three are POSIX shell keywords. Reproduced with pnpm exec fallow dead-code --format json --quiet: unlisted_binaries contains exactly those three keywords. Narrow workaround: ignoreBinaries lists only if, then, fi; real unlisted binaries remain enforced. The parser should recognize shell control syntax rather than requiring package declarations for keywords.
