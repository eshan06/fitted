#!/usr/bin/env bash
# Counted changed lines (added + deleted) on this branch since <base>, excluding
# tests, Markdown, lockfiles, generated files and migrations. Santa and the CI
# size check both call this, so they never disagree.
# Usage: scripts/count-lines.sh [base] [head]   (defaults origin/main, HEAD)
set -euo pipefail
base="${1:-origin/main}"
head="${2:-HEAD}"
git diff --numstat "$base...$head" | awk -F'\t' '
  $1 == "-" { next }                                            # binary
  {
    p = $3                                                      # a rename prints as dir/{old => new}
    if (p ~ / => /) { gsub(/\{[^{}]* => /, "", p); gsub(/\}/, "", p); sub(/^.* => /, "", p) }
  }
  p ~ /(^|\/)(__tests__|tests?)\// { next }                     # test folders
  p ~ /\.(test|spec)\.[^\/]+$/ { next }                         # test files
  p ~ /\.md$/ { next }                                          # Markdown
  p ~ /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/ { next }
  p ~ /\.generated\./ || p ~ /^app\/types\/.*\.d\.ts$/ { next }   # generated code, GraphQL codegen
  p ~ /(^|\/)migrations\// { next }                             # migrations
  { n += $1 + $2 }
  END { print n + 0 }'
