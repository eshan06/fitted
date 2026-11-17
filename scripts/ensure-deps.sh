#!/bin/sh
# Installs dependencies in a fresh checkout or worktree. Without them, Node
# resolves packages from a parent folder's node_modules and silently checks the
# branch against the main checkout's code. Run by hooks in .claude/settings.json.
[ -n "$CI" ] && exit 0 # CI installs on its own; never run install scripts in a CI job
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$top/package-lock.json" ] || exit 0
[ -f "$top/node_modules/.package-lock.json" ] && exit 0 # npm writes this last, so a half install retries
mkdir "$top/.ensure-deps.lock" 2>/dev/null || exit 0  # another call is already installing
trap 'rmdir "$top/.ensure-deps.lock"' EXIT
echo "ensure-deps: installing dependencies in $top" >&2
(cd "$top" && npm ci --no-audit --no-fund >&2 && npx prisma generate >&2) ||
  echo "ensure-deps: install failed; run 'npm ci && npx prisma generate' before any check" >&2
exit 0
