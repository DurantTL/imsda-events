# People module

Owns permanent people, households, household membership, account-to-person
links, and future organization affiliations. Stable person and organization
provider keys live in the shared `ExternalIdentity` model; the church/club
directory is owned by `modules/organizations`.

Event-specific answers belong to registration or attendee snapshots rather
than overwriting identity history.

## Account-to-person links (`account-links-domain.ts`, `account-links-repository.ts`)

`AttendeeAccountPersonLink` and `UserPersonLink` are explicit, provenance-
carrying links from a login account to a durable `Person`. **A link grants
nothing by itself.** No staff permission, no event access, and no
cross-event visibility follows from a link existing — `User`,
`AttendeeAccount`, `Person`, and `RegistrationAttendee` remain distinct
concepts, and `modules/access/authorization.ts` never reads these tables.
See `tests/account-links-invariant.test.ts`.

Merge/unmerge itself is still out of scope here (slice 3, #127 — not yet
built). Match suggestions and the review queue are now in this module; see
below.

## Duplicate match candidates and the review queue (`duplicate-match-domain.ts`, `duplicate-match-repository.ts`, `duplicate-match-access.ts`)

Identity slice 2 (#126). `PersonMatchCandidate` records that two `Person`
rows may be the same person, with the evidence for and against, a
deterministic and versioned confidence tier, and a state
(`OPEN` → `DISMISSED` / `SUPERSEDED`; `MERGED` is reserved for slice 3 and
nothing here ever sets it). **Candidates are generated; they are never
applied.** No code path in this module merges anything.

Matching is pure and rule-based (`duplicate-match-domain.ts`, no Prisma
calls) so it is testable and so re-running it over unchanged data always
produces the same result — no fuzzy scoring a reviewer cannot trace back to
a rule. `DUPLICATE_MATCH_RULE_VERSION` is bumped whenever a rule changes,
and every candidate records the version that produced it. The signals
compared today are normalized email, normalized phone, shared active
household, shared `ExternalIdentity` `(provider, providerScope,
externalId)`, and name similarity. **Not compared: date of birth** — the
issue's spec lists it, but `Person` has no such column yet; adding one is
out of this slice's scope (see the #126 PR description).

A pure name match with nothing else in common is deliberately never
surfaced (IMSDA is a small community where shared names are common and
would be noise), but the same surname plus a shared household is (the
"twins" case a human should look at).

`generateMatchCandidates` (`duplicate-match-repository.ts`) is idempotent:
a `fingerprint` hashes every input that can change a candidate's evidence,
plus the rule version, and the DB-unique `(personAId, personBId,
fingerprint)` is what makes a rerun over unchanged data write nothing. A
dismissed pair stays suppressed until its fingerprint changes; an
already-open candidate whose signals changed is superseded rather than
duplicated. `personAId` is always lexicographically less than `personBId`
(`PersonMatchCandidate_ordered_pair_check`), so the pair — not an ordered
tuple — is the unit the constraint reasons about.

The review queue (`/people/matches`) is gated on `globalRole ===
"SYSTEM_ADMIN"`, not any single event's `EventPermission`: `Person` is
global and cross-event, and the queue must not become a route to identity
data a reviewer could not otherwise see. It discloses only the fields a
reviewer needs to decide identity (names, normalized email/phone, matched
and contradicting signals) — never registrations, payments, medical, or
consent records. It offers three outcomes: **Dismiss** (state change,
requires a reason, audited), **Defer** (no state change — the candidate
stays `OPEN`; only an audit entry records the touch), and **Merge**
(disabled — a "coming soon" affordance, since slice 3 does not exist yet).

## Time-bounded household membership (`household-domain.ts`, `household-repository.ts`)

`HouseholdMember` carries `effectiveFrom` / `effectiveTo` so a past
registration can read its historical household context instead of today's.
Removing a member closes the row (`effectiveTo`); it is never deleted. A
database exclusion constraint prevents two overlapping memberships of the
same person in the same household. `canManage` is a household-convenience
flag, not guardian authority — guardian authority is declared explicitly
(#43), never inferred from household membership.

Legacy rows without `effectiveFrom` are backfilled with the idempotent,
dry-run-by-default `npm run household-membership:backfill`
(`household-backfill.ts`).
