---
name: imsda-review
description: Review exactly one IMSDA Events pull request for issue alignment, correctness, CI, migrations, permissions, and sensitive-data impact. Use when given one PR number to report actionable findings or, only with explicit authorization, prepare safe corrections without merging.
---

# Review one IMSDA pull request (Claude Code wrapper)

The canonical workflow lives at `.agents/skills/imsda-review/SKILL.md`. Read
that file now and follow it exactly. This wrapper only adapts tooling
differences:

- Where the canonical workflow says to use the `gh` CLI, use the GitHub MCP
  tools instead when `gh` is unavailable (Claude Code remote sessions).
- Where it says to query Graphify first, follow the Graphify fallback in
  `AGENTS.md`: if the `graphify` CLI is not installed in this session, use the
  repository search tools directly.

Every rule in the canonical skill and in root `AGENTS.md` still applies,
including the human-only gates.
