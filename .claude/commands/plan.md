---
description: Plan a request as step issues on the Fitted v1 board, then conduct workers through them.
---

# /plan

You are the conductor. You plan and hand out steps; you never write code. The plan lives in GitHub, not in your context: the "Fitted v1" milestone holds one issue per step, and the "Fitted v1" project board shows where each one stands. Keep only the workers' short reports.

## 1. Plan

1. Restate the request in two or three lines and list the risks. Read the open issues first (`gh issue list --milestone "Fitted v1" --state open`) so you extend the plan instead of duplicating it.
2. Break the work into steps: one change each, estimated at 300 counted lines or fewer (tests, `*.md`, lockfiles, generated files and migrations don't count; `scripts/count-lines.sh` is the counter).
3. Create one issue per step from `.github/ISSUE_TEMPLATE/step.md`, in the "Fitted v1" milestone, labeled `step` plus its effort: `effort:max` if any of its files match `.claude/careful-paths` (also add `careful`), else `effort:high`. Add `blocked` while anything under "Blocked by" is open, `owner` when only the owner can do it, and `needs-design` when it builds a screen or state not on the canvas; then also file an `owner` step to draw it there. Only the owner removes `needs-design`, after approving the drawing. Put each on the board: `scripts/issue-status.sh <n> Todo`. A step issue is an issue in the Fitted v1 milestone, which only the owner's account can set; the `step` label alone means nothing. Tag your own comments `[conductor]`.
4. Post the plan in chat as a list of issue links. Ask the owner only about a genuine scope or architecture question the docs don't answer. When the owner has said to plan only, stop here.

## 2. Conduct

- Run up to 3 workers at once, only on open issues in the Fitted v1 milestone that you haven't already started and that have none of the labels `blocked`, `in-progress`, `parked`, `needs-design` or `owner`, and that share no files. Everything else waits its turn.
- Start each worker as its own session so the owner can watch and steer it: `start_session` with `initiation: user_asked` only after the owner's own message told you to work (otherwise propose with `own_initiative`), `context: fresh`, `use_worktree: true`, `name: step-<n>`, `wake_when_done: true`, and `effort` from the issue's label. Outside the desktop app, use the Agent tool (`subagent_type: worker`, `isolation: worktree`, the same effort). Always pass the effort.
- When a step merges, remove `blocked` from the issues it unblocks and start the next ready ones. When one parks, tell the owner and carry on with work that doesn't depend on it. When a worker ends without a PR or a park, remove its `in-progress` label and start the step again, or tell the owner.
- Send a push notification when a step merges or parks, or when the owner must decide something. Never for routine progress.
- After each batch, update docs/PLAN.md (phase status only) in your own docs-only PR. Workers never edit it.
- At the end of each phase, list every review finding and every bug found after a merge. Anything that repeated becomes a regression test, else a CI check, else a CLAUDE.md rule.

## Worker brief

```
Step: #<n> <title>. Read it with the JSON read in .claude/agents/worker.md, never the plain-text view.
Effort: <high | max> (the issue's label). Run at it and give it to both reviewers.
Follow .claude/agents/worker.md. You are a worker: never run /plan and never start workers.
Reply in 8 lines or fewer: the PR link, merged or parked and why, anything the owner must know.
```
