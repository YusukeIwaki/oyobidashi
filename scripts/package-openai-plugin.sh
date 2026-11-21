#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_dir="$repo_root/plugins/oyobidashi"
output_dir="$repo_root/.oyobidashi/plugin-submission"
mkdir -p "$output_dir"

stage_dir="$(mktemp -d)"
trap 'find "$stage_dir" -depth -delete' EXIT
package_dir="$stage_dir/package"
mkdir -p "$package_dir"
cp -R "$plugin_dir"/{plugin.json,mcp.json,LICENSE,README.md,assets,skills} "$package_dir/"

# The submission portal reads explicit DCR settings. The installed Codex
# plugin discovers DCR from the server, including on clients that reject extensions.
bun -e '
  const path = Bun.argv.at(-1);
  const config = await Bun.file(path).json();
  config.mcpServers.oyobidashi.extensions = {
    "com.openai": { auth: { type: "oauth", client: { mode: "dcr" } } },
  };
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
' "$package_dir/mcp.json"

(cd "$package_dir" && zip -q -r "$stage_dir/oyobidashi.zip" plugin.json mcp.json LICENSE README.md assets/icon.png skills/use-oyobidashi/SKILL.md)
mv "$stage_dir/oyobidashi.zip" "$output_dir/oyobidashi.zip"
printf '%s\n' "$output_dir/oyobidashi.zip"
