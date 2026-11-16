#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if ! command -v bun >/dev/null 2>&1; then
  echo 'Bun が必要です。https://bun.sh/docs/installation を確認してインストールしてください。' >&2
  exit 1
fi
exec bun run "$root/scripts/setup-local.ts" "$@"
