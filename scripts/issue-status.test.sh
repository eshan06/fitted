#!/usr/bin/env bash
# Self-test for issue-status.sh against a fake gh that records its calls.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/issue-status.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/gh" <<'GH'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "project list") echo '{"projects":[{"number":7,"title":"Fitted v1"},{"number":3,"title":"Other"}]}' ;;
  "project view") echo '{"id":"PVT_1"}' ;;
  "project field-list") echo '{"fields":[{"id":"F_title","name":"Title"},{"id":"F_status","name":"Status","options":[{"id":"o_todo","name":"Todo"},{"id":"o_prog","name":"In progress"}]}]}' ;;
  "repo view") echo '{"nameWithOwner":"eshan06/fitted"}' ;;
  "project item-add") echo '{"id":"ITEM_9"}' ;;
  "project item-edit") ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
GH
chmod +x "$tmp/gh"
export PATH="$tmp:$PATH" GH_LOG="$tmp/log"
out="$(bash "$script" 12 "In progress")"
[ "$out" = "#12 -> In progress" ] || { echo "issue-status self-test: got [$out]" >&2; exit 1; }
grep -q -- 'item-add 7 --owner eshan06 --url https://github.com/eshan06/fitted/issues/12' "$GH_LOG" || { echo "issue-status self-test: wrong item-add" >&2; exit 1; }
grep -q -- 'item-edit --id ITEM_9 --project-id PVT_1 --field-id F_status --single-select-option-id o_prog' "$GH_LOG" || { echo "issue-status self-test: wrong item-edit" >&2; exit 1; }
if bash "$script" 12 "Shipped" >/dev/null 2>&1; then echo "issue-status self-test: an unknown status should fail" >&2; exit 1; fi
echo "issue-status self-test: ok"
