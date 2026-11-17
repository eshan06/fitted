#!/usr/bin/env bash
# Self-test for check-attribution.sh: clean history passes; each kind of attribution fails.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/check-attribution.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q -b main && git config user.email t@example.com && git config user.name t
git commit -q --allow-empty -m base && git checkout -qb work
git commit -q --allow-empty -m "feat: clean change"
expect() { # expect <pass|fail> <label> [PR_BODY]; HEAD_ARG / BASE_ARG override the range
  if PR_BODY="${3:-}" bash "$script" "${BASE_ARG:-main}" ${HEAD_ARG:+"$HEAD_ARG"} >/dev/null 2>&1; then r=pass; else r=fail; fi
  [ "$r" = "$1" ] || { echo "check-attribution self-test: $2 should $1" >&2; exit 1; }
}
expect pass "clean history"
expect fail "footer in PR body" $'## What\nx\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'
expect fail "Co-Authored-By in PR body" $'## What\nx\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
expect fail "session link in PR body" $'## What\nx\nhttps://claude.ai/code/session_123'
for msg in $'fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>' \
  $'fix: thing\n\nhttps://claude.ai/code/session_123' \
  $'fix: thing\n\nClaude-Session: abc' \
  $'fix: thing\n\n\U0001F916 Generated with [Claude Code](https://claude.com/claude-code)'; do
  git commit -q --allow-empty -m "$msg"
  git commit -q --allow-empty -m "chore: clean commit on top"   # the bad one is not the tip
  expect fail "attribution in a commit below the tip: ${msg##*$'\n'}"
  git reset -q --hard HEAD~2
done
git commit -q --allow-empty -m $'fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
git checkout -q main                                          # CI's shape: checkout at base, head passed in
HEAD_ARG=work expect fail "attribution with an explicit head"
BASE_ARG=no-such-ref HEAD_ARG=work expect fail "a base that doesn't exist"
echo "check-attribution self-test: ok"
