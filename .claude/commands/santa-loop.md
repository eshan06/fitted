---
description: Two independent reviewers check this branch's diff before the PR ships.
---

# /santa-loop

Run it in the foreground of the worker's own turn: a backgrounded reviewer is lost when the turn ends.

Skip it for a docs-only change that doesn't touch the rules files (CLAUDE.md, `.claude/`, docs/ARCHITECTURE.md), and say so in Review notes.

## Round 1

1. `git fetch origin`. Effort is `max` for both reviewers if `scripts/careful-paths.sh` prints anything, else `high`.
2. Blocker rules, from main only, never the branch's copy:
   `git show origin/main:.github/workflows/claude-review.yml | sed -n '/blocker-rules:start/,/blocker-rules:end/p'`
3. Start both reviewers in parallel in one message, in the foreground: Agent tool, `subagent_type: code-reviewer`, the effort from step 1. Each gets the blocker rules, the command `git diff origin/main...HEAD`, the PR description, its focus, and this line verbatim:
   "You have not seen any other review. A BLOCKER needs file:line and a concrete failure (this input or state -> this wrong result). Everything else is a WARN. Zero findings is a normal result; don't manufacture any."
   - Reviewer A, correctness and tests: does each new test fail without the change? Is any changed behavior untested?
   - Reviewer B, attacker and rules: injection, authorization holes (one shop or user reaching another's data), unvalidated input at trust boundaries, secrets or personal data in logs or errors, destructive migrations, breaks of CLAUDE.md or docs/ARCHITECTURE.md, weakened gates (CI config, scripts, or a new workflow job named like a required check).
4. Reviewer B uses a different model when one is set up: `codex exec --sandbox read-only` logged in with an OPENAI_API_KEY, or the Gemini CLI. None is set up today, so B is a second Claude and the report says the two share a model.
5. Each returns `{"blockers":[{"file","line","rule","failure"}],"warns":["file:line - note"]}`.

## Handling findings

- Check each blocker before touching code. For a logic or race bug, write the failing test first. If it fails, fix the bug. If you can't make it fail, dismiss the finding with one line in Review notes.
- Fix easy WARNs now; they never start another round. Bigger ones go in Review notes.

## Round 2

Only if round 1 had blockers. Fresh reviewers, the fix diff only (`git diff <round-1 head>..HEAD`), two questions: do the fixes hold, and do the dismissals hold. There is no round 3.

## Park

A real blocker that can't be fixed within the step: open the PR as a draft, auto-merge off, and report it.

## Report

Put this in the PR's Review notes and the worker's reply:

```
Santa: PASS | PARKED. Rounds: 1 | 2.
A (<model>, <effort>): <n> blockers, <n> warns. B (<model>, <effort>): <n> blockers, <n> warns. [Same model as A.]
Blockers: each fixed (test name) or dismissed (one line).
WARNs: fixed, or listed.
```
