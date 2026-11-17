#!/usr/bin/env bash
# Self-test for careful-paths.sh: careful files are listed, others aren't, and
# moving a file off a careful path still counts.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/careful-paths.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q -b main && git config user.email t@example.com && git config user.name t
mkdir -p .claude app/routes
printf '# comment\napp/shopify.server.ts\napp/routes/auth.*\napp/*billing*\n' > .claude/careful-paths
printf 'export {}\n' > app/shopify.server.ts
git add . && git commit -qm base && git checkout -qb work
printf 'x\n' > app/routes/auth.callback.tsx                    # careful
mkdir -p app/models && printf 'x\n' > app/models/billing.ts    # careful
printf 'x\n' > README.md                                       # not careful
git mv app/shopify.server.ts app/server.ts                     # moved off a careful path
git add . && git commit -qm work
got="$(bash "$script" main | sort | tr '\n' ' ')"
want="app/models/billing.ts app/routes/auth.callback.tsx app/shopify.server.ts "
[ "$got" = "$want" ] || { echo "careful-paths self-test: expected [$want], got [$got]" >&2; exit 1; }
echo "careful-paths self-test: ok"
