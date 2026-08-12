# In-process Effect scheduler replaces Ofelia

## Status

Accepted

## Context

Production scheduling previously depended on an external Ofelia container
watching Docker labels, an idle worker kept alive with `sleep infinity`, and a
second process capturing job output. That split observability across containers,
required Docker socket access, and kept the only production scheduling path
outside Effect's typed errors, redacting logger, and testable runtime.

## Decision

The application exposes two run modes selected from environment configuration:

- `RUN_MODE=once` performs exactly one Synchronization Attempt and exits. It
  remains available for manual `docker exec` diagnostics and CI-style runs.
- `RUN_MODE=schedule` runs the existing Synchronization Attempt through the
  in-process cron scheduler until interrupted. Each tick runs the job as a fresh
  scoped unit, failures are logged through the shared redacting logger without
  terminating the worker, and optional no-overlap protection skips a tick while
  a previous run is still active.

Schedule policy is decoded with Effect Config from `SYNC_CRON`, `SYNC_TIMEZONE`,
and `SYNC_NO_OVERLAP`. The cron expression and IANA timezone are validated
eagerly at config decode with `Cron.parse`, so an invalid schedule fails fast as
a typed configuration error. The container image defaults to scheduler mode via
`ENV RUN_MODE=schedule` and `bin/run-schedule.sh`; the one-shot path remains
available as `bin/run-sync.sh` or `RUN_MODE=once`.

The scheduler core owns the recurring program and its testable timing,
failure-continuation, interruption, and no-overlap behavior. The composition
root installs the redacting logger once and covers both modes. Catch-up or
missed-run semantics beyond a plain cron schedule, and persistence of scheduler
state across restarts, are out of scope.

The homelab compose migration away from Ofelia is a separate deployment change;
the application image remains backward compatible with the existing one-shot
invocation until that adoption lands.

## Considered options

- **External Ofelia scheduler** — rejected because it requires a Docker socket
  mount, an extra container, an idle worker, and a separate observability path
  outside Effect's typed runtime.
- **CLI subcommands or flags** — rejected because the application has one real
  command plus scheduling; environment-selected modes keep the entrypoint thin
  and deployment configuration as the source of truth.
- **Scheduler as the runtime default** — rejected because keeping one-shot as
  the runtime default preserves backward compatibility for existing invocations;
  the container default is set explicitly at the Docker layer.

## Consequences

- The homelab stack can drop Ofelia, its Docker socket mount, scheduler labels,
  and the idle sleep command when it adopts the new image.
- Scheduled and one-shot runs share one Effect logging and redaction path.
- The worker process contract changes from exit-after-once to run-forever in
  scheduler mode; shutdown is interrupt-driven and the deployment should
  configure a restart policy for the long-lived worker.
- Invalid schedules are rejected before application work starts with typed,
  readable errors.
