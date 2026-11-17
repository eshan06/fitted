#!/bin/sh
# Installs dependencies in a fresh checkout or worktree. Without them, Node
# resolves packages from a parent folder's node_modules and silently checks the
# branch against the main checkout's code. Run by hooks in .claude/settings.json.
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$top/package-lock.json" ] || exit 0
[ -d "$top/node_modules" ] && exit 0
echo "ensure-deps: installing dependencies in $top" >&2
(cd "$top" && npm ci --no-audit --no-fund >&2 && npx prisma generate >&2) ||
  echo "ensure-deps: install failed; run 'npm ci && npx prisma generate' before any check" >&2
exit 0
