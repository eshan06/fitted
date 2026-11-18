#!/usr/bin/env bash
# Puts a step issue on the "Fitted v1" project board in the given column.
# Usage: scripts/issue-status.sh <issue-number> <Todo|In progress|In review|Parked|Done>
set -euo pipefail
issue="$1"
status="$2"
owner="eshan06"
title="Fitted v1"
project=$(gh project list --owner "$owner" --format json | jq -r --arg t "$title" '.projects[] | select(.title == $t) | .number')
[ -n "$project" ] || { echo "issue-status: no project named '$title'" >&2; exit 1; }
project_id=$(gh project view "$project" --owner "$owner" --format json | jq -r .id)
field=$(gh project field-list "$project" --owner "$owner" --format json | jq -c '.fields[] | select(.name == "Status")')
field_id=$(jq -r .id <<<"$field")
option=$(jq -r --arg s "$status" '.options[] | select(.name == $s) | .id' <<<"$field")
[ -n "$option" ] || { echo "issue-status: the board has no '$status' column" >&2; exit 1; }
repo=$(gh repo view --json nameWithOwner | jq -r .nameWithOwner)
item=$(gh project item-add "$project" --owner "$owner" --url "https://github.com/$repo/issues/$issue" --format json | jq -r .id)
gh project item-edit --id "$item" --project-id "$project_id" --field-id "$field_id" --single-select-option-id "$option" >/dev/null
echo "#$issue -> $status"
