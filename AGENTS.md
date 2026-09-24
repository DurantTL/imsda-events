# IMSDA Events automation guide

## Repository map and commands

- `app/`: Next.js pages and route handlers.
- `components/`: shared UI.
- `modules/`: domain boundaries in the modular monolith.
- `prisma/`: schema, committed migrations, and synthetic seed data.
- `tests/`: Vitest permission, domain, route, and regression tests.
- `docs/`: runbooks, decisions, and readiness evidence.
- `.agents/skills/`: repository-scoped build and review workflows.
- `.claude/`: Claude Code configuration (session hook, permissions, thin
  wrappers around the `.agents/skills/` workflows, and subagents in
  `.claude/agents/`; routing rules are in `CLAUDE.md`).

## Roadmap and issue conventions

GitHub issue #98 is the canonical ordered roadmap. Its **build queue** section
comes first: work `queue-1` issues in the listed order, then `queue-2`, then
`queue-3`. The phase order below it is the long-term roadmap.
`docs/BUILD-STATUS-AND-WR26-GAP-AUDIT.md` is historical status evidence, not the
roadmap, and `docs/LEGACY-EVENT-SYSTEMS.md` records what the 2026 event systems
did. Labels mirror the phases (`phase-0` … `phase-5`); `codex-ready` marks the
currently claimable frontier for automated builds (only the current queue);
`needs-decision` and `needs-human` mark issues blocked on a human and are never
`codex-ready`.

Use Node.js 20.9 or newer. Start locally with `npm install`, the PostgreSQL
Compose service, `npm run db:deploy`, `npm run db:seed`, and `npm run dev`.
Run focused tests while editing. `npm run verify` is the canonical full check
(lint, generated route types and TypeScript, tests, and production build);
GitHub CI also migrates and seeds a clean PostgreSQL database.

## Build workflow

1. Query the installed Graphify project before broad repository searches
   (`graphify query "<question>"`). Verify every finding against current source
   files; Graphify is derived and rebuildable. When the `graphify` CLI is not
   installed (for example cloud agent sessions), skip this step and use the
   repository search tools directly — do not fail or wait on Graphify.
2. Use exactly one approved GitHub issue and one isolated worktree per build.
   Continue an existing issue branch or PR instead of duplicating it.
3. Implement only the issue's acceptance criteria, preserve unrelated changes,
   add proportional tests, and run targeted checks locally. Let the complete
   GitHub CI gate run for every code PR.
4. Keep the modular monolith: add behavior to the owning `modules/` boundary,
   keep event authorization server-side, and use adapters for external systems.

If requirements are unclear and the answer would materially change behavior,
stop, apply the GitHub label `needs-decision`, and record the decision needed.

## Data and human gates

Use synthetic development data only. Never put production database contents,
attendee exports, medical records, insurance documents, secrets, or payment
credentials in prompts, Graphify, Obsidian, issues, tests, fixtures, screenshots,
logs, or commits.

Only a human may approve or perform merging, deployment, production migrations
or imports, refunds, bulk communications, pricing or capacity changes, identity
merging, medical-data handling, or insurance-rule changes. Automation may
prepare reviewable artifacts but must not cross those gates.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
