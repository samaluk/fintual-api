---
title: 'Fallow 3.16 still warns about invalid @actual-app/api entry patterns'
severity: 'minor'
target: 'fallow-rs/fallow'
---

Every fallow run emits repeated warnings that pkg.dependencies?.['@actual-app/api'] and pkg.devDependencies?.['@actual-app/api'] are invalid globs (bracket contents parsed as character ranges). This predates the 3.16 upgrade (see existing friction #331) and is an upstream built-in-plugin issue; the audit still succeeds. Verify whether fallow-rs/fallow fixed it in a later release before re-logging.
