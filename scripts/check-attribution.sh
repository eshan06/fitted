#!/usr/bin/env bash
# Fails if any commit since <base> carries a Co-Authored-By line or a Claude
# session trailer, or if $PR_BODY carries a "Generated with Claude Code" footer.
# Usage: PR_BODY="..." scripts/check-attribution.sh [base]   (default origin/main)
set -euo pipefail
base="${1:-origin/main}"
trailer='^co-authored-by:|claude\.(ai|com)/code|^claude-session|generated with \[?claude code'
bad=0
for sha in $(git rev-list "$base..HEAD"); do
  if git log -1 --format=%B "$sha" | grep -qiE "$trailer"; then
    echo "::error::Commit ${sha:0:7} carries Claude attribution (Co-Authored-By or a session trailer). Reword it."
    bad=1
  fi
done
if printf '%s\n' "${PR_BODY:-}" | grep -qiE 'generated with \[?claude code'; then
  echo '::error::The PR description carries a "Generated with Claude Code" footer. Remove it.'
  bad=1
fi
exit "$bad"
