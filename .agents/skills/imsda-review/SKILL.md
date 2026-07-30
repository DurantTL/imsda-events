---
name: imsda-review
description: Review exactly one IMSDA Events pull request for issue alignment, correctness, CI, migrations, permissions, and sensitive-data impact. Use when given one PR number to report actionable findings or, only with explicit authorization, prepare safe corrections without merging.
---

# Review one IMSDA pull request

Accept exactly one positive PR number. Read root `AGENTS.md` before acting.

## Workflow

1. Confirm `gh` authentication and read the PR metadata, linked issue, complete
   diff, checks, review comments, and unresolved review threads.
2. Query Graphify for affected domains and call paths before broad searches.
   Verify every graph result against the PR head and current source.
3. Compare the diff with the linked acceptance criteria and out-of-scope list.
   Inspect database migrations and rollback constraints, event authorization and
   permissions, audit/idempotency behavior, logs/exports, and any medical,
   insurance, identity, payment, registration, pricing, or capacity impact.
4. Read CI results without weakening or bypassing a gate. Reproduce focused
   failures locally when practical.
5. Report only actionable findings, ordered by severity, with exact file and
   line references. Then list verification gaps and decisions separately. Say
   explicitly when no findings remain.
6. Make corrections only when the user explicitly authorizes them. Keep fixes
   on the PR branch, synthetic-data-only, scoped to the finding, and supported
   by targeted checks.

Never approve on a human's behalf, merge, deploy, run production migrations or
imports, refund, send bulk communications, change live pricing/capacity, merge
identities, or decide medical/insurance rules.
