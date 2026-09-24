@AGENTS.md

# Claude Code: delegating to subagents

These rules are for Claude Code only (Codex reads `AGENTS.md`). Delegate by
these rules without asking first; they count as the user's request to use
subagents. The agents live in `.claude/agents/`.

- **explorer** (Haiku): broad searches, tracing call paths, and digesting long
  output (CI logs, test failures, issue lists, big diffs). Do small, targeted
  lookups yourself; spawning costs more than one or two searches.
- **implementer** (Sonnet): one whole `codex-ready` issue with acceptance
  criteria, in its own worktree. Never for small edits, design questions, or
  `needs-decision` / `needs-human` issues.
- **reviewer** (Sonnet): before opening or updating any code PR. Run it on Opus
  (pass `model: opus`) when the issue is labelled `sensitive-data` or
  `payments`, or the change adds a migration.
- **Design decisions, hard debugging, and anything needing this conversation's
  context stay in the main session.** Subagents start without it.

**Escalation.** Move up one model tier only on objective failure: checks still
fail after the agent's attempts, CI is red, or the reviewer reports a blocking
finding. Escalate once, passing along the failure output, not a fresh start.
Unclear requirements don't escalate; they get the `needs-decision` label and a
question to a human.

**Always verify.** Treat a subagent's "done" as a claim. Run the checks
yourself (`npx eslint . --max-warnings=0`, `npx tsc --noEmit -p .`, the focused
tests) before pushing.
