#!/usr/bin/env bash
set -euo pipefail

# Usage: bash scripts/migrate-subagent-sessions.sh [agent-dir]
agent_dir="${1:-$HOME/.pi/agent}"
old="$agent_dir/sessions/subagents"
new="$agent_dir/pi-subagents/sessions"

if [[ ! -d "$old" ]]; then
    echo "Nothing to migrate: $old does not exist."
    exit 0
fi

mkdir -p "$new"
shopt -s dotglob nullglob
for session in "$old"/*; do
    mv -i -- "$session" "$new/"
done
rmdir -- "$old"
echo "Migrated subagent sessions to $new"
