#!/usr/bin/env bash
# Prints the files changed since <base> that match .claude/careful-paths, read
# from <base> so a branch can't drop a path to lower its own review effort.
# Empty output means no careful path is touched.
# Usage: scripts/careful-paths.sh [base]   (default origin/main)
set -euo pipefail
base="${1:-origin/main}"
globs="$(git show "$base:.claude/careful-paths" 2>/dev/null || cat "$(git rev-parse --show-toplevel)/.claude/careful-paths")"
git diff --name-only "$base...HEAD" | while IFS= read -r f; do
  while IFS= read -r g; do
    case "$g" in '' | '#'*) continue ;; esac
    # shellcheck disable=SC2053  # $g is a glob on purpose; * also matches /
    if [[ "$f" == $g ]]; then echo "$f"; break; fi
  done <<<"$globs"
done
