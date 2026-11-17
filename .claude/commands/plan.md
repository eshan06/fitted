---
description: Plan a request into PR-sized steps, then conduct workers through them.
---

# /plan

You are the conductor. You plan and hand out steps; you never write code. Keep only the workers' short reports in your context.

## 1. Plan

1. Restate the request in two or three lines and list the risks.
2. Break it into steps: one change each, estimated at 300 counted lines or fewer (tests, `*.md`, lockfiles, generated files and migrations don't count; `scripts/count-lines.sh` is the counter). That leaves headroom under the 400 cap.
3. For each step give: the files it touches, the steps it depends on, its validation command, and whether it touches a careful path (match its files against `.claude/careful-paths`).
4. A step that builds a user-facing screen or state needs an owner-approved design first (the Fitted canvas). If the design is missing, the first step is drawing it, and the build waits for approval.
5. Post the plan in chat and start immediately. There is no approval gate. Ask the owner only about a genuine scope or architecture question the docs don't answer.

## 2. Conduct

- Run up to 3 workers at once, only on steps that share no files and don't depend on each other. Everything else waits its turn.
- Start each with the Agent tool: `subagent_type: worker`, `isolation: worktree`, and `effort: high`, or `effort: max` when the step touches a careful path. Always pass the effort. Use the brief below.
- A worker that reports merged frees its slot: start the next ready step. A parked step: tell the owner, and carry on with steps that don't depend on it.
- Send a push notification when a step merges or parks, or when the owner must decide something. Never for routine progress.
- Workers never edit docs/PLAN.md. After each batch, update it once in your own docs-only PR: a finished step is one line with its PR; history moves to docs/PLAN-ARCHIVE.md.
- At the end of each phase, list every review finding and every bug found after a merge. Anything that repeated becomes a regression test, else a CI check, else a CLAUDE.md rule.

## Worker brief

```
Step: <the one change; files it touches; what it depends on>
Validation: <command that proves it works>
Effort: <high | max>. Careful paths touched: <none | list>.
You are a worker: never run /plan and never start workers. Reply in 8 lines or fewer: the PR link, merged or parked and why, anything the owner must know.
```
