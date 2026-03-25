#!/bin/sh
set -eu

exec xvfb-run -a sh -lc 'node src/once.ts'
