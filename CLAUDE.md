@AGENTS.md

# Claude Code: delegating to subagents

These rules are for Claude Code only (Codex reads `AGENTS.md`). Delegate by
these rules without asking first; they count as the user's request to use
subagents. The agents live in `.claude/agents/`.

- **explorer** (Haiku): broad searches, tracing call paths, and digesting long
  output (CI logs, test failures, issue lists, big diffs). Do small, targeted
  lookups yourself; spawning costs more than one or two searches.
- **implementer** (Sonnet 5.5, pinned as `claude-sonnet-5-5` because the
  `sonnet` alias can lag a release): one whole `codex-ready` issue with
  acceptance criteria, in its own worktree. Never for small edits, design
  questions, or `needs-decision` / `needs-human` issues.
- **reviewer** (Opus): before opening or updating any code PR. It is the
  safety net for everything the cheaper models build, so it always runs on
  Opus. It reports findings; it never fixes them.
- **Design decisions, hard debugging, and anything needing this conversation's
  context stay in the main session.** Subagents start without it.

**Fixes stay on Sonnet.** Opus reviews and coordinates; it does not write
fixes. When checks fail, CI is red, or the reviewer reports a blocking
finding, send the failure output and the reviewer's findings back to an
**implementer** (resume the original builder when it is still available, so
it keeps its context), not to an Opus implementer. If the same finding
survives two Sonnet fix rounds, the main session takes the hard part itself
(a small, targeted change or a precise plan for the implementer) rather than
spawning an Opus builder. Unclear requirements don't escalate; they get the
`needs-decision` label and a question to a human.

**Always verify.** Treat a subagent's "done" as a claim. Run the checks
yourself (`npx eslint . --max-warnings=0`, `npx tsc --noEmit -p .`, the focused
tests) before pushing.
