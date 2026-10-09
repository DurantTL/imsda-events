# Honors Weekend instructors (#833)

An instructor signs in and sees only the class rosters they teach, and marks
attendance and completion. Decided by Caleb on Oct 8, 2026 (issue #833).

## Who instructors are

Instructors are **attendee-account people**, handled like club directors and
deputies (#376, #425), not staff users. They are volunteers who sign in with an
ordinary account; staff `User` accounts carry event-wide permissions this role
must never inherit.

1. Staff open **More, Honors Weekend classes, Instructors** (`CONFIGURE_EVENT`
   on that event), enter the instructor's name and email, and choose their
   class or classes. The invite is emailed right away (one deliberate send to
   one person, never a bulk send); if account email isn't set up it waits and
   staff press Resend later.
2. The invited person creates an account or signs in with that email. Their
   account page shows **Accept** next to the instructor invite. The invite
   carries no secret: only a signed-in account whose **verified email** is the
   invite's address can accept, and only the person themselves (a staff member
   switched into an attendee view cannot).
3. From then on they see **Your classes**: only the classes they were assigned.

Staff can change an instructor's classes or remove them at any time; access
follows immediately. Past marks stay. Removing an instructor also removes their
class assignments. Inviting a removed instructor again starts over: exactly the
new classes, and they must accept again. Resending an open invite has the same
5-minute cooldown as club invites, and the sign-up link prefills the invited
email.

The invite finds the instructor's person by email, but only when the typed name
agrees with that person (so someone sharing an address cannot pass on another
person's Sterling Volunteers check); otherwise staff are told "That email belongs
to a different person in the system; use the instructor's own email."

Data: `HonorInstructor` (one per event and email, tied to a `Person` so the
Sterling Volunteers check can be matched), `HonorInstructorClass` (the classes
they teach), `HonorEnrollmentMark` (their attended and completed marks).

## What an instructor sees

Name and club, nothing else: no contact, health, guardian or birth-date data,
no ages, no registration or person ids. The read path is its own narrow query
(`modules/honors/instructor-repository.ts`, `rosterEnrollmentSelect`) that never
loads a registration's answers, and `toInstructorRosterRow` builds each row from
an allowlist. A group registration shows as "Group registration", never a
person's name. `tests/honor-instructor-routes.test.ts` and
`npm run test:honor-instructors` / `test:honor-instructors-http` prove it.

## Authorization

Every read and write starts from the signed-in account's own assignment
(`loadAssignment`): there is no account id or class id in a request that can
widen it. A class that isn't theirs, an unassigned class, another event's class
and a class that doesn't exist all answer the same 404.

## Sterling Volunteers check

An instructor needs a **current Sterling Volunteers check** to see a roster or
mark it. This is the one place a check blocks access (everywhere else it only
flags), because the roster exposes names of young people. The check is matched
through the existing list (#405, #527) by `currentCheckStateForPerson`. Without
one, the roster page and API show a clear message and no names; staff see on the
Instructors page each instructor's state.

A roster import's "!" mark (FLAGGED) counts as **not current** for this gate,
although it is current everywhere else: this is the one blocking context, so the
safer reading wins. A Sterling check that is valid but expires within 60 days is
still a current check and does not block. Both are pending the owner's
confirmation and live in one function (`sterlingAllowsRoster`). The staff page
labels a flagged "!" check as such.

## Marks

- Per person: **Attended** and **Completed**. Completed also marks attended;
  taking attended away takes completed away.
- One click: **All attended**, **All completed**, **Clear**.
- Marks open when the event starts (the roster is readable before; marking
  before then is 409 `MARKS_NOT_OPEN`) and can change until **14 days after the
  event ends**. After that the roster **closes** too: the page says "This class
  roster has closed." and the API answers 404 `ROSTER_CLOSED`.
- Instructors pass the same **second step** as club roles (an accepted
  instructor is part of `accountHasSecondStepAccess`): roster pages and the
  roster and marks APIs require it.

## Completion and the honor record

Completed writes the member's honor record **immediately**, through the existing
Honors Weekend write-back (#487, #812): the same transaction, locks and links,
one record per person and honor, attributed to the instructor's attendee
account (`recordedByAccountId`) and audited. A person with no club roster record
has nothing to write to; they stay marked and are counted as skipped.

Once a completion is in the honor record it is **locked for the instructor**
(one-click Clear skips it and says so). **Staff void it** with the existing
honor entry void (#591); a voided completion is never re-created, and the row
shows "Recorded, later voided by staff".

A marks call takes the write-back's own per-event lock first (with the
write-back's transaction limits; if it still times out the caller gets a 409
"Try again in a moment"), re-checks the instructor's assignment under it, so what is
recorded is read under the lock the write-back writes under.

An instructor's mark governs the staff write-back run: someone marked attended
only is not completed by a later check-in-based run (the staff notice counts
them as skipped). Someone with no instructor
mark is still completed by check-in, as before.

## Audit

Each mark call writes `HONOR_CLASS_MARKS_UPDATED` with the event, class,
instructor, account, action and counts: ids and counts only, never names.
Invites, class changes, accepting and removing are audited too.
