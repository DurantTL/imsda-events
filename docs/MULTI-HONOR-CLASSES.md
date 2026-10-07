# Honors Weekend classes that teach several honors (#812)

One Honors Weekend class (`HonorOffering`) can teach one or more catalog honors.
A person enrolled in the class is enrolled in each honor it teaches, takes one
seat, and completing the class completes each honor. Honors Weekend only.

## Data model

- `HonorOfferingHonor` is the source of truth: one row per honor a class
  teaches, with a `position` (0 is the primary honor).
- `HonorOffering.honorId` is kept as the class's **primary** honor (position 0)
  so older readers and plain `honorId` filters still work. A trigger inserts the
  position-0 row whenever a class is inserted, and the repository keeps the two
  in step on every edit. Never read `honorId` to learn what a class teaches.
- `HonorOfferingHonor` also holds a copy of the class's `eventId`, `sessionId`
  and `locationId` (the site), kept in step by triggers (insert copies them; a
  move of the class updates them). That lets the database itself enforce the
  rules below per honor.
- `HonorWeekendCompletionLink` gains `honorId` and is unique on
  (`enrollmentId`, `honorId`): one link, and one member honor record, per honor.
- Migration `20261009100000_honor_offering_multiple_honors` is additive. It
  backfills one row per existing class (and `honorId` on every existing link),
  then moves the uniqueness rules. The partial indexes and triggers are
  hand-written and are left alone by `prisma migrate diff`.

## Uniqueness rules (what changed and why)

The old rules were per honor, so they are now per honor taught:

| Rule | Before | Now |
| --- | --- | --- |
| No honor twice in one session | unique (`sessionId`, `honorId`) on the class | unique (`sessionId`, `honorId`) on `HonorOfferingHonor`, so it holds across classes: two classes of one session can't teach the same honor |
| One all-sessions class per honor, event with no sites | partial unique (`eventId`, `honorId`) where no session, no site | same, on `HonorOfferingHonor` |
| One all-sessions class per honor per site | partial unique (`eventId`, `honorId`, `locationId`) | same, on `HonorOfferingHonor` |

The existing app-level rules are unchanged and now apply to every honor of the
class (`classSlotConflict`): an all-sessions honor can't also be in a single
session at the same site, and two sites may teach the same honor. The same honor
may still be taught in different sessions by different classes.

## Lock once clubs have enrolled

The lock that freezes a class once anyone is enrolled is applied per honor:

- No honor can be **removed** (enrollees and written-back records name it).
- No honor can be **added**. Adding was considered, because enrollment is per
  class and the new honor would reach enrollees automatically. It is refused
  because those enrollees chose the class for the honors it listed (and, after
  the weekend, would be completed in an honor they never saw), and a human would
  have to decide that. The refusal names the honors, for example "Birds can't be
  removed and Fire Building can't be added".
- The **order** of the same honors, and the seats, teacher, room, cost and
  notes, can still change.
- An honor the catalog has since turned off stays on a class that already
  teaches it; a new inactive honor can't be added.

## Enrollment, capacity and exports

- Enrollment stays per class (`HonorEnrollment.offeringId`): one seat, one
  per-club-limit count, however many honors. The picker, rosters and exports show
  the class by its honors joined with " + " (`honorName`, `honorCode`).
- The class roster CSV keeps one row per person, with the joined honor codes and
  names in the existing "Honor code" and "Honor" columns. The club schedule CSV
  and the public class grid use the joined names.
- Copying a site and cloning an event copy a multi-honor class whole. A class is
  skipped when any of its honors is inactive.

## Completion

"Write back completions" writes one COMPLETED `MemberHonorEntry` per honor a
class teaches, with one `HonorWeekendCompletionLink` each. A member who already
has a COMPLETED record of one of the honors is linked to it instead of getting a
second. Running it again, or twice at once, writes nothing twice.

## Checks

`npm run test:multi-honor-classes` (real PostgreSQL) covers the backfill, the
database rules, multi-honor enrollment, the lock, completion, exports and races.
