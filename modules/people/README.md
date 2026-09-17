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

Match suggestions, a review queue, and merge/unmerge are out of scope here
(later slices of #40).

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
