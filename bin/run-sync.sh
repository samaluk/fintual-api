#!/bin/sh
set -eu

exec xvfb-run -a sh -lc 'node dist/once.js'
