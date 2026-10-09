# Honors Weekend class level and prerequisite honors (#832)

Decided by Caleb on Oct 8, 2026 (issue #832). Staff can give an Honors Weekend
class a **minimum Investiture class level** and **prerequisite honors**. The
server enforces both where it enforces minimum age (`selectionProblem` in
`modules/honors/enrollment-domain.ts`, run inside the serializable enrollment
transaction of `setClassSelections`).

## Source of truth

- **Level:** the member's current class level on the club roster
  (`ClubRosterMember.classLevel`), set by the director. The order is the
  roster's own: Friend, Companion, Explorer, Ranger, Voyager, Guide, TLT,
  Master Guide. "Guide and up" accepts Guide, TLT and Master Guide.
- **Prerequisite honors:** the member's honor record (`MemberHonorEntry`). A
  prerequisite counts only when the person's **latest non-voided entry** for it
  (highest `seq`; the record is append-only) is COMPLETED, the same rule as the
  Honors page and master-award progress (`completedHonorsByPerson` in
  `modules/honors/completed-honors.ts`). A completion later corrected to in
  progress, an in-progress entry, and a voided entry do not count; a later
  re-completion counts again.
- Staff, adults and underage children take no seat and are never asked
  (`consumesClassSeat`). A guest or "Group" person has no roster member, so
  they have no level and no record.

## What each case does

| Case | Result |
| --- | --- |
| Level at or above the minimum, every prerequisite completed | Allowed, nothing recorded |
| Level known and below the minimum | Refused. A director cannot confirm past it. Staff acting as the director can override |
| Level missing | Allowed only if the director ticks "I confirm they meet it" for that class. Recorded |
| A prerequisite honor has no completed record | Allowed only with the same director confirmation, per class. Recorded |
| Staff override | Needs a reason (3 to 300 characters). Only staff acting as a club's director (#442) may send one; an attendee account or group contact is refused |

A class someone already holds is never re-checked (like minimum age), so an
existing placement survives later saves.

## What is recorded

On each new `HonorEnrollment`: `levelConfirmedByDirector`,
`prerequisitesConfirmedByDirector` (only when that gap really existed and was
confirmed), `requirementOverrideReason` and `requirementOverriddenByUserId`. The
class-save audit entry (`HONOR_CLASSES_UPDATED`) lists the confirmations by
person and class. Each override also writes its own
`HONOR_CLASS_REQUIREMENT_OVERRIDDEN` audit entry with the reason and which rules
were unmet.

## Where staff set it

Honors Weekend class setup (#357): "Minimum class level" and "Prerequisite
honors" on a class (`HonorOffering.minimumClassLevel`,
`HonorOfferingPrerequisite`). They apply to the class as a whole, including a
class that teaches several honors (#812); a class cannot require an honor it
teaches. Copying a site's classes and cloning an event carry both. The public
class grid shows them as badges.

## The picker

Both pickers (the registration step and the registered club's page) grey out a
class when the level is known to be too low and say why ("Guide+ (this person is
Ranger)"). A class that only needs a confirmation stays pickable; once picked, a
tick box appears under the person. Staff acting as the director also get a
reason box. The ticks are not kept in the registration draft: after a reload the
director ticks again.

## "Group" registrations (judgment call)

A group has no director or roster to vouch for anyone, so a group cannot confirm
a missing level or record. A class with a level or prerequisite is therefore not
open to group registrations. Staff cannot place a group person past it today (staff act as a club director only); that needs a follow-up decision.

## Adding or raising a requirement on a class people are enrolled in

Nobody is removed: enrolled youth keep their seats. When an edit **raises** the
minimum level or **adds** prerequisite honors, the save returns
`requirementImpact: { offeringId, unmet }`, the setup screen says "N enrolled
youth don't meet this; they keep their seats" (singular for one), and the
`HONOR_OFFERING_UPDATED` audit metadata gets `enrolledYouthNotMeetingRequirement`.
It is a count only, never names. The count covers only what the edit introduced:
the level when it was raised, and only the newly added prerequisite honors
(`countUnmetByChange` in `enrollment-domain.ts`). Youth already accepted (by
director confirmation or staff override) for a requirement that did not change
are not counted. Lowering a level or removing a prerequisite reports nothing. It
counts seated youth in submitted or confirmed registrations of this event; a
guest or group person has no level or record and counts as not meeting it.

## Checks

`npm run test:honor-class-requirements` (real PostgreSQL) and
`tests/honor-class-requirements.test.ts`.
