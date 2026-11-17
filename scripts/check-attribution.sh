#!/usr/bin/env bash
# Fails if any commit since <base>, or $PR_BODY, carries Claude attribution: a
# Co-Authored-By line, a Claude session trailer or link, or a "Generated with
# Claude Code" footer.
# Usage: PR_BODY="..." scripts/check-attribution.sh [base] [head]   (defaults origin/main, HEAD)
set -euo pipefail
base="${1:-origin/main}"
head="${2:-HEAD}"
trailer='^co-authored-by:|claude\.(ai|com)/code|^claude-session|generated with \[?claude code'
bad=0
shas="$(git rev-list "$base..$head")"   # assigned first, so a bad base fails instead of checking nothing
for sha in $shas; do
  if git log -1 --format=%B "$sha" | grep -qiE "$trailer"; then
    echo "::error::Commit ${sha:0:7} carries Claude attribution (Co-Authored-By or a session trailer). Reword it."
    bad=1
  fi
done
if printf '%s\n' "${PR_BODY:-}" | grep -qiE "$trailer"; then
  echo '::error::The PR description carries Claude attribution (a footer, Co-Authored-By or a session link). Remove it.'
  bad=1
fi
exit "$bad"
