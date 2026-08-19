#!/bin/sh
set -eu

exec env RUN_MODE=schedule node src/main.ts
