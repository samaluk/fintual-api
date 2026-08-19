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

The once and schedule modes share one Effect-native process entrypoint. The
`RUN_MODE` value selects the application program after configuration is decoded;
`bin/run-sync.sh` and `bin/run-schedule.sh` both invoke `src/main.ts` with their
respective mode explicitly. This keeps the deployment distinction in
environment configuration rather than maintaining parallel entry modules.

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

The scheduler ships as a breaking major version (v3). The image default command
becomes the long-lived scheduler process, changing the process contract from
exit-after-once to run-until-interrupted. The previous invocation contract is
**not** preserved: there is no retro-compatibility shim, and v3+ images do not
accept the old invocation. Homelab adoption is intentionally later and outside
this project's tracker; when the homelab stack adopts v3, it drops Ofelia, its
Docker socket mount, the scheduler labels, and the idle sleep command as one
deployment change.

## Considered options

- **External Ofelia scheduler** — rejected because it requires a Docker socket
  mount, an extra container, an idle worker, and a separate observability path
  outside Effect's typed runtime.
- **CLI subcommands or flags** — rejected because the application has one real
  command plus scheduling; environment-selected modes keep the entrypoint thin
  and deployment configuration as the source of truth.
- **Backward-compatible default with Ofelia removal later** — considered while
  the scheduler landed, then rejected for the shipped major: the container
  default now runs the scheduler, so the old contract cannot be preserved.
  Keeping a compatibility shim would have to distinguish "one-shot by default"
  from "one-shot on request" across invocations and would have delayed the
  homelab migration without protecting any external consumer; the one-shot path
  remains available explicitly via `RUN_MODE=once` and `bin/run-sync.sh`.

## Consequences

- The homelab stack drops Ofelia, its Docker socket mount, scheduler labels,
  and the idle sleep command when it adopts the new image.
- Scheduled and one-shot runs share one Effect logging and redaction path.
- The worker process contract changes from exit-after-once to run-forever in
  scheduler mode; shutdown is interrupt-driven and the deployment should
  configure a restart policy for the long-lived worker.
- The v3 major is a breaking release: existing invocations that rely on the
  one-shot default must pass `RUN_MODE=once` explicitly or keep a v2 image.
- Invalid schedules are rejected before application work starts with typed,
  readable errors.
