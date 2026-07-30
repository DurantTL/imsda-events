---
name: imsda-build
description: Build exactly one codex-ready IMSDA Events GitHub issue through an isolated worktree and draft pull request. Use when given one issue number to claim, plan, implement, test, push, and open for review without merging or deploying.
---

# Build one IMSDA issue

Accept exactly one positive issue number. Read root `AGENTS.md` before acting.

## Workflow

1. Confirm `gh` authentication and the `imsda-events` remote. Read the issue and
   require the `codex-ready` label. If scope is materially unclear, add
   `needs-decision`, state the missing decision, and stop.
2. Search open and closed PRs, remote branches, and worktrees for the issue.
   Continue an existing build; do not create a duplicate.
3. Query the installed Graphify project about the affected workflow before broad
   searches, then verify its findings against current source.
4. Use the existing isolated worktree or create one from current `origin/main`
   with a `codex/issue-<number>-<slug>` branch. Assign the issue to yourself and
   leave a short claim comment naming the branch.
5. Write a bounded plan from the issue's acceptance criteria. Preserve the
   modular-monolith boundaries and unrelated changes. Use synthetic data only.
6. Implement only accepted scope, add proportional tests, and run targeted
   checks. Run broader checks when risk warrants; the full GitHub CI remains the
   canonical gate.
7. Review the diff against `origin/main`, commit only intended files, push the
   branch, and open a draft PR using the repository template. Link the issue and
   report verification evidence and unresolved decisions.

Never merge, deploy, run a production migration or import, issue refunds, send
bulk communications, change live pricing/capacity, merge identities, or handle
medical/insurance data. Leave every human-only gate to a human.
