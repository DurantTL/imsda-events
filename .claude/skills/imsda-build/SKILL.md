---
name: imsda-build
description: Build exactly one codex-ready IMSDA Events GitHub issue through an isolated worktree and draft pull request. Use when given one issue number to claim, plan, implement, test, push, and open for review without merging or deploying.
---

# Build one IMSDA issue (Claude Code wrapper)

The canonical workflow lives at `.agents/skills/imsda-build/SKILL.md`. Read that
file now and follow it exactly. This wrapper only adapts tooling differences:

- Where the canonical workflow says to use the `gh` CLI, use the GitHub MCP
  tools instead when `gh` is unavailable (Claude Code remote sessions).
- Where it says to query Graphify first, follow the Graphify fallback in
  `AGENTS.md`: if the `graphify` CLI is not installed in this session, use the
  repository search tools directly.

Every rule in the canonical skill and in root `AGENTS.md` still applies,
including the human-only gates.
