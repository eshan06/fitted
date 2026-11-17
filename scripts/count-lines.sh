#!/usr/bin/env bash
# Counted changed lines (added + deleted) on this branch since <base>, excluding
# tests, Markdown, lockfiles, generated files and migrations. Santa and the CI
# size check both call this, so they never disagree.
# Usage: scripts/count-lines.sh [base]   (default origin/main)
set -euo pipefail
base="${1:-origin/main}"
git diff --numstat "$base...HEAD" | awk -F'\t' '
  $1 == "-" { next }                                            # binary
  $3 ~ /(^|\/)(__tests__|tests?)\// { next }                    # test folders
  $3 ~ /\.(test|spec)\.[^\/]+$/ { next }                        # test files
  $3 ~ /\.md$/ { next }                                         # Markdown
  $3 ~ /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/ { next }
  $3 ~ /\.generated\./ { next }                                 # generated code
  $3 ~ /(^|\/)migrations\// { next }                            # migrations
  { n += $1 + $2 }
  END { print n + 0 }'
