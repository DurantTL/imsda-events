# Consent policies

Slice 1 of #43 stores consent, waiver, acknowledgment, and approval-required
policies as definitions with immutable published versions. Presentation,
acceptance, guardian authority, staff approval decisions, and migration of
existing form answers belong to later slices.

- `ConsentPolicy` carries a `kind` and a `scope`. Event-scoped policies belong
  to one event; organization-scoped policies have no event. Kind, scope, and
  event are fixed at creation (check constraint plus trigger), and
  `requirePolicyKind` narrows a policy so one kind can never satisfy another.
- `ConsentPolicyVersion` follows the form and message-template draft-then-publish
  pattern: at most one draft per policy, drafts are edited in place, and
  publishing freezes the draft. Unlike forms, a published version is **never
  archived or otherwise updated** — date selection and evidence must be able to
  reach every version anyone has seen. A correction is a new version.
- Immutability is enforced three ways: the repository only writes rows whose
  status is still `DRAFT` (conditioned in the `WHERE` clause, so a concurrent
  publish is also refused), a trigger rejects any `UPDATE` of a published row,
  and a check constraint requires publisher, timestamp, hash, effective
  start, and material-change judgment on every published row.
- Publishing records the effective window (half-open: `effectiveFrom <= at <
  effectiveTo`, open-ended when `effectiveTo` is null), the publisher, a SHA-256
  content hash, and a human-set `isMaterialChange` flag. The flag is required
  for every published version; it is never inferred by diffing text.
- `getPolicyVersionEffectiveAt` answers "what is presented at this moment"
  from effective windows (overlaps resolve to the higher version number).
  `getPolicyVersionForEvidence` answers "what did this person see" by exact
  version id. They are intentionally separate queries.
- `EventConsentPolicyApplicability` configures, per event, which policies apply
  to which attendee type, role, and age band (evaluated on the event start
  date) and whether agreement is required. A row may reference the event's own
  policies or organization-scoped ones only. Rows are deactivated, not deleted.
- Staff manage event policies and applicability through
  `/api/events/{eventId}/consent-policies` and
  `/api/events/{eventId}/consent-policy-applicability` with `CONFIGURE_EVENT`.
  Organization-scoped policies are readable there but are not authored through
  event routes.

Policy text is staff-entered data. No legal text belongs in this repository;
tests use obviously synthetic placeholder text.
