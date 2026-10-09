# Honors Weekend schedule board (#834)

Decided by Caleb on Oct 8, 2026 (issue #834): an editable drag-and-move board.
Staff open **Honors Weekend classes, Schedule board** (`/more/honors/schedule`).
Only people with `CONFIGURE_EVENT` (the same permission as class setup) can see
or change it; every write route checks it on the server (`requireHonorPermission`).

## What it shows

- One section per site (an event with no sites is one section). Sessions run
  across the top, then an **All sessions** column; rooms run down the side, then
  a **No room yet** row for classes not placed.
- One card per class: the honors taught, **seats taken / capacity** (youth
  seats), a **Nearly full** label from 80% of the seats and **Full** at capacity
  (a label and a coloured edge, never colour alone), and the instructors.
- A **Clash** flag on both cards when one instructor is in two classes of the
  same session (an all-sessions class counts as being in every session of its
  site).
- Rooms are managed under each site ("Rooms at ..."): add, rename, change seats,
  remove (refused while a class is in it).

## Moving a class

Two ways, both sending the same request (`POST .../honors/offerings/:id/move`
with `{ roomId, sessionId? }`); the server decides:

- **Drag** the card to a cell (mouse).
- **Move, then Move here** (phones, keyboards, screen readers): choose Move on a
  card, then Move here on a cell. Cells that can't take the class say why.
  Escape or Cancel move backs out. All controls are at least 44 px on a phone.

The grid scrolls sideways inside its own region; the page never does.

## Rules the server enforces (`modules/honors/schedule-repository.ts`)

| Rule | Result |
| --- | --- |
| A class can't have more seats than its room | Refused when placing it, raising its seats, or shrinking the room (`ROOM_TOO_SMALL`). A database trigger backs this up. |
| One active class per room per session; an all-sessions class holds the room for every session | `ROOM_BOOKED`. Backed by a partial unique index (room, session). |
| The room must be at the class's site | `ROOM_WRONG_SITE` |
| A class with people enrolled never changes site | `OFFERING_HAS_PICKS` (clubs picked it for their site) |
| Moving an enrolled class into a session where an enrolled person already holds another class | **Blocked** (`MOVE_HAS_CONFLICTS`), with the number of people in conflict. Not confirmable: nobody is double-booked or dropped. Cancelled registrations hold nothing and don't count. |
| Honor uniqueness (`docs/MULTI-HONOR-CLASSES.md`) | Unchanged: no honor of the class twice in the destination session (`OFFERING_CONFLICT`). |
| Seats and enrollments | A move never changes capacity or enrollments, so it can't overfill a class. |
| An all-sessions class | Changes room only, within its own site. |

A move runs in one serializable transaction that first locks the class row, the
same row a club's class pick locks, so a move and a pick at the same moment run
one after the other or one retries (and, if retries run out, "try again",
`SCHEDULE_BUSY`). Each move is audited (`HONOR_OFFERING_MOVED`).

The older class form still refuses to change a class's session or site once
anyone is enrolled; the board is the way to move an enrolled class within its
site. Editing a placed class's seats or active state, or its session or site,
re-checks the room rules.

## Data

Migration `20261013110000_honor_rooms_schedule_board` is additive: `HonorRoom`
(site, name, capacity), a nullable `HonorOffering.roomId`, the partial unique
indexes, and the two capacity triggers. While a class is in a room its
free-text `location` mirrors the room's name, so grids and exports that already
show it keep working. Rooms are not copied by "copy from another event" or event
cloning yet (the free-text room is).

## Instructors (#833)

Instructor assignments are a separate branch. Until its tables exist the card
shows the class's free-text `teacherName` and no clash is ever flagged. The one
extension point is `loadOfferingInstructors` in `schedule-repository.ts`: return
`{ id, name }` per class and the card and `instructorClashes` work unchanged.

## Checks

`npm run test:honor-schedule-board` (real PostgreSQL, in `ci.yml`) covers room
capacity (app and database), booking, enrolled moves (no overfill, conflict
block with count, site, uniqueness), and races. Unit and route tests are in
`tests/honors-schedule-board.test.ts`.
