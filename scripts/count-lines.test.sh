#!/usr/bin/env bash
# Self-test for count-lines.sh: builds a throwaway repo and checks the count.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/count-lines.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q -b main && git config user.email t@example.com && git config user.name t
printf 'base\nold\n' > keep.ts
mkdir -p docs && seq 1 50 > docs/guide.md
git add . && git commit -qm base
git checkout -qb work
printf 'base\nnew\n' > keep.ts                                   # counted: 1 added + 1 deleted
printf 'a\nb\nc\n' > app.ts                                      # counted: 3
printf 't\n' > app.test.ts                                       # test file
mkdir -p tests && printf 't\n' > tests/x.ts                      # test folder
printf 's\n' > check.test.sh                                     # shell self-test
printf 'doc\n' > README.md                                       # Markdown
git mv docs/guide.md docs/manual.md && printf 'x\n' >> docs/manual.md   # renamed and edited Markdown
printf '{}\n' > package-lock.json                                # lockfile
mkdir -p prisma/migrations/1 && printf 'sql\n' > prisma/migrations/1/m.sql
printf 'g\n' > admin.generated.d.ts                              # generated
mkdir -p app/types && printf 't\n' > app/types/admin.types.d.ts # GraphQL codegen output
git add . && git commit -qm work
git checkout -q main && printf 'later\n' > later.ts && git add . && git commit -qm "main moves on" && git checkout -q work
got="$(bash "$script" main)"
[ "$got" = 5 ] || { echo "count-lines self-test: expected 5, got $got" >&2; exit 1; }
echo "count-lines self-test: ok"
