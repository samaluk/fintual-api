# Synchronization Attempt is one Effect service

## Status

Accepted

## Context

The application has two domain services that form one retryable business unit:
Fintual produces a validated `PerformanceSnapshot`, and Actual applies that
snapshot through its reconciliation workflow. The former entrypoint passed a
runtime configuration tree into a shallow `runJob` function and separately
wrapped both the job and scheduler as services. That shape made configuration
ownership and the complete attempt boundary implicit.

## Decision

The application owns one `Job` `Context.Service` for the complete
Synchronization Attempt:

```text
synchronize(): Effect<void, JobError>
```

`JobError` is the named union `ActualError | FintualError`. The job layer
acquires `FintualPerformance` and `ActualSynchronization` once and sequences
the two public operations. It does not wrap or retype their failures.

Actual, Fintual, Email 2FA, and schedule configuration are provided as domain
configuration services once at the composition root. Email 2FA configuration
is an `Option`; schedule configuration contains an eagerly parsed cron value.
The redaction policy receives only the validated secrets list and does not
depend on the runtime configuration tree.

The scheduler remains a plain application module. It receives an
`Effect<void, JobError>` and parsed schedule options, while `app.ts` selects
the once or schedule program from `ScheduleConfigService`. `RunJobService`,
`SchedulerService`, the configuration-taking `runJob` function, and the
parallel once entry module are not retained.

## Considered options

- **Keep a configuration-taking `runJob` function** — rejected because it
  exposes composition concerns at every call site and hides the complete
  attempt boundary.
- **Wrap the job and scheduler in separate services** — rejected because both
  wrappers only forwarded calls and made the real domain seam harder to see.
- **Create a new wrapper error** — rejected because `JobError` can preserve the
  truthful lower-level domain failures without redundant translation.
- **Use `Layer.launch` for both process modes** — rejected because launch is
  inherently long-running, while once mode must complete and exit.

## Consequences

- The public synchronization workflow has one discoverable service contract.
- Configuration and adapter lifetime are resolved by the composition root,
  while tests can replace either domain service or any leaf layer explicitly.
- Once and schedule mode share one process entrypoint; `RUN_MODE` remains the
  deployment contract.
- Scheduler timing tests remain independent from application composition.
