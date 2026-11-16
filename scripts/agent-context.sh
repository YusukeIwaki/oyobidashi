#!/bin/sh
# Claude Code SessionStart: 共通のエントリポイントだけをコンテキストに渡す。
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cat "$root/AGENTS.md"
