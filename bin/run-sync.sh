#!/bin/sh
set -eu

exec env RUN_MODE=once node src/main.ts
