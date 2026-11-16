#!/bin/sh
set -eu
oyobidashi_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export OYOBIDASHI_HOME="${OYOBIDASHI_HOME:-$oyobidashi_root/.oyobidashi}"
exec bun run "$oyobidashi_root/relay/src/cli.ts" serve "$@"
