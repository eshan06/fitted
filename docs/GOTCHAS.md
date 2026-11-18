# Gotchas

Live traps only, one short entry each. The PR that fixes a trap deletes its entry.

- **Claude Review, Size and Attribution run main's copy of their workflow** (`pull_request_target`), so a PR that edits one is checked by the old version; the change takes effect after merge. They don't run at all on the PR that first adds them. Required checks match by name, so a PR could add a decoy workflow with a job named like a gate: reviewers treat any new workflow job named CI gate, Size, Attribution or Claude Review as a blocker (rule break).
- **GitHub silently turns off auto-merge when a required check fails.** Turn it back on after the fix is green.
- **Auto-merge can merge while you're still pushing.** Run `git fetch --prune` before re-pushing a branch; if it already merged, put the new commit on a fresh branch from main.
- **A fresh worktree has no node_modules,** and Node then resolves packages from the main checkout's, checking your branch against main's code. The ensure-deps hook installs them; if it didn't run, `npm ci && npx prisma generate` before the first check.
- **Reviewer subagents must run in the foreground** of the worker's turn; a backgrounded one is lost when the turn ends. Some hosts (the Claude desktop app) start them in the background anyway: then wait for both reports before acting, and never ship on one.
- **In a cloud session `gh pr create` may fail.** Use the GitHub MCP, then strip the footer it adds to the description.
- **The Shopify CLI needs an interactive terminal** for sign-in and prompts. Run it in the owner's terminal, or pass every flag (`--name`, `--flavor`, `--client-id`).
- **The agent shell may be zsh,** which compares `[[ $f == $glob ]]` as plain text. Run the pipeline scripts by path (their shebang is bash), never by pasting their loops into the shell.
- **Files in `app/routes/` become routes, except tests:** `ignoredRouteFiles` in `app/routes.ts` drops `**/*.test.{ts,tsx}` and must match the Vitest `include` in `vitest.config.ts`. Drift can fail the build, or pass silently: a file that is neither a route nor a test.
- **Board commands need the `project` scope** on the gh login (`gh auth refresh -s project`). Without it, `scripts/issue-status.sh` fails; the issue labels still hold the state.
- **Every agent posts to GitHub as the owner.** Tell agent comments from owner steering by the `[conductor]` / `[worker step-<n>]` tag, never by author.
