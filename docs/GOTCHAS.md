# Gotchas

Live traps only, one short entry each. The PR that fixes a trap deletes its entry.

- **The review workflow can't pass on the PR that adds or edits it** (the action's tamper protection). Land it before it becomes a required check. Later edits need the owner to turn the required check off, merge, and turn it back on.
- **GitHub silently turns off auto-merge when a required check fails.** Turn it back on after the fix is green.
- **Auto-merge can merge while you're still pushing.** Run `git fetch --prune` before re-pushing a branch; if it already merged, put the new commit on a fresh branch from main.
- **A fresh worktree has no node_modules,** and Node then resolves packages from the main checkout's, checking your branch against main's code. The ensure-deps hook installs them; if it didn't run, `npm ci && npx prisma generate` before the first check.
- **Reviewer subagents must run in the foreground** of the worker's turn; a backgrounded one is lost when the turn ends.
- **In a cloud session `gh pr create` may fail.** Use the GitHub MCP, then strip the footer it adds to the description.
- **The Shopify CLI needs an interactive terminal** for sign-in and prompts. Run it in the owner's terminal, or pass every flag (`--name`, `--flavor`, `--client-id`).
- **The agent shell may be zsh,** which compares `[[ $f == $glob ]]` as plain text. Run the pipeline scripts by path (their shebang is bash), never by pasting their loops into the shell.
