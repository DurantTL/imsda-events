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
  backfills one row per existing class, then moves the uniqueness rules. The
  backfill statement skips a class that already has a row, so it is safe to run
  again (the verify script runs the migration's own statement twice). Each
  existing completion link takes its `honorId` from the member record it points
  at, falling back to the class's honor only if that record were missing. The partial indexes and triggers are
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

## Changing a class's honors after people enrolled

Decision (Caleb, Oct 7): staff can add or remove the honors a class teaches even
after students have enrolled. Enrollment is per class, so the honors follow.

- **Adding** an honor gives it to everyone enrolled, and the completion
  write-back includes it for them.
- **Removing** an honor takes it from them. The one refusal: an honor already
  written back as completed for any enrollee of the class (a completion link)
  can't be removed. The message says it "was already recorded as completed for N
  students in this class" and tells staff to void those records first.
- **Confirmation.** When the honors change on a class people are enrolled in, the
  editor asks "12 students are enrolled. They will now take: Birds + Knots." and
  sends that count back as `confirmEnrolled`. The server counts the enrollments
  inside its serializable transaction and refuses a missing or stale number with
  `HONORS_NEED_CONFIRMATION` and the live count, which the editor asks about
  again. So an honor edit racing an enrollment either applies or asks again; it
  never applies silently to a different number of students.
- A class keeps at least one honor and at most 12.
- Reordering the same honors, and seats, teacher, room, cost and notes, need no
  confirmation.
- **Still fixed once anyone is enrolled:** the class's session, span and site
  (unchanged from before). An honor the catalog has since turned off stays on a
  class that already teaches it; a new inactive honor can't be added.
- An edit that both moves a class and changes its honors drops the removed honor
  rows first, then moves the class (its remaining rows follow it), then adds the
  new ones, so swapping the honor a destination session already teaches works.

## Enrollment, capacity and exports

- Lists of classes (staff setup, the club picker) are ordered by the class's honor
  names in alphabetical order, so reordering a class's honors never moves it.
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
database rules, multi-honor enrollment, adding and removing honors after
enrollment (including the refusal after write-back), editing honors while moving a
class, completion, exports and races (seats, honor edits, an honor edit against an
enrollment, write-backs).
