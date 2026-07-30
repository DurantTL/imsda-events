# Automation runbook

This repository uses a reviewable, one-issue delivery loop:

1. Draft a feature in Obsidian with the
   [feature-spec template](templates/OBSIDIAN-FEATURE-SPEC.md). Obsidian is for
   drafting only. Keep the required YAML frontmatter intact: `spec_id`,
   `status`, `milestone`, `risk`, and `github_issue_url`.
2. Preview with `npm run issue:from-spec -- <spec.md>`; preview mode never
   changes GitHub or the note. After a human sets `status: approved`, apply with
   `--apply`. The helper is idempotent by `spec_id`, never overwrites an existing
   issue, and records the authoritative issue URL in `github_issue_url`.
3. GitHub becomes authoritative when the approved issue exists. Add
   `codex-ready` only when its behavior and acceptance criteria are buildable.
4. Use one issue, one branch, and one isolated worktree. `$imsda-build` may
   prepare a draft PR; `$imsda-review` may report findings. Neither may merge or
   deploy.
5. Run targeted local checks while editing. The unchanged `verify` GitHub job is
   the canonical full gate for every PR.

Graphify is a derived, rebuildable map: query it before broad searches and
verify results against source. It is never an authority for requirements or
runtime data.

No participant data or sensitive operational data may enter Obsidian or
Graphify. Use synthetic examples only, and keep production databases, attendee
exports, medical or insurance documents, secrets, and payment credentials out
of the automation loop.

## WR26 pre-rehearsal readiness evidence

Before asking a human to begin staging or release review, run the read-only
configuration checklist against the intended event:

```sh
npm run event:readiness -- --event <slug>
```

The command reports stable check codes, aggregate active-registration counts,
blockers, and warnings without printing participant or configuration values. A
blocker returns a non-zero status; warnings alone do not. Save the output as
pre-rehearsal evidence, not authorization: human sign-off is still required for
staging/release decisions, deployment, migrations, payment enablement, and all
other human-only gates.

Human approval is always required for the gates in [root guidance](../AGENTS.md),
including merge, deployment, production data changes, refunds, bulk sends,
pricing/capacity changes, identity merges, and medical or insurance rules. When
a material behavioral requirement is unclear, add `needs-decision` and stop.

The [build-status and WR26 audit](BUILD-STATUS-AND-WR26-GAP-AUDIT.md) is the
canonical roadmap and contains the execution-plan template.
