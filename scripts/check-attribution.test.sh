#!/usr/bin/env bash
# Self-test for check-attribution.sh: clean history passes; each kind of attribution fails.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/check-attribution.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q -b main && git config user.email t@example.com && git config user.name t
git commit -q --allow-empty -m base && git checkout -qb work
git commit -q --allow-empty -m "feat: clean change"
expect() { # expect <pass|fail> <label> [PR_BODY]
  if PR_BODY="${3:-}" bash "$script" main >/dev/null 2>&1; then r=pass; else r=fail; fi
  [ "$r" = "$1" ] || { echo "check-attribution self-test: $2 should $1" >&2; exit 1; }
}
expect pass "clean history"
expect fail "footer in PR body" $'## What\nx\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'
git commit -q --allow-empty -m $'fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
expect fail "Co-Authored-By trailer"
git reset -q --hard HEAD~1
git commit -q --allow-empty -m $'fix: thing\n\nhttps://claude.ai/code/session_123'
expect fail "session trailer"
echo "check-attribution self-test: ok"
