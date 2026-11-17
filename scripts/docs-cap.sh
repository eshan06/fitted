#!/usr/bin/env bash
# Word caps for the rules and planning files. At a cap, merge or delete a rule
# before adding one.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bad=0
while read -r cap file; do
  [ -f "$file" ] || continue
  n=$(wc -w < "$file" | tr -d ' ')
  if [ "$n" -gt "$cap" ]; then
    echo "::error file=$file::$n words; the cap is $cap. Merge or delete text before adding more."
    bad=1
  else
    echo "$file: $n/$cap words"
  fi
done <<'CAPS'
1200 CLAUDE.md
3000 docs/PLAN.md
1500 docs/GOTCHAS.md
1000 .claude/commands/plan.md
1000 .claude/commands/santa-loop.md
CAPS
exit "$bad"
