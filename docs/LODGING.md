# Lodging inventory, availability and preferences (#198 slice 1, #199 slice 2)

Reusable lodging inventory for on-site properties, with per-event state and
night-by-night availability computed on the server. The inventory tables hold
**facility data only**: no person, assignment or waitlist (assignment is #200),
and no occupant names from the source sheets. What guests *asked for* lives in
separate tables (see "Preferences and roommate requests (#199)" below) and is
never an assignment.

Code lives in `modules/lodging/`; the staff screens are **More > Lodging**
(`/more/lodging`, inventory) and **More > Lodging requests**
(`/more/lodging/requests`, preferences and the review queue).

## Setup

```
npm run db:deploy
npm run lodging:sync
```

`lodging:sync` (like `club-forms:sync`) creates the Camp Heritage and
Sunnydale Academy property templates and brings them to the version in the
code. It is idempotent and safe on every deploy (`docker-entrypoint.sh` runs it
after `prisma migrate deploy`):

- A template is applied only when its `version` in
  `modules/lodging/templates/` is newer than the stored one. **Bump `version`
  whenever a template changes**, or the sync leaves it alone.
- A serialization lock (a Postgres advisory lock) makes two parallel syncs
  apply a template once.
- A unit that a newer version no longer lists is *retired* (`retiredAt`), never
  deleted, because events may reference it. It returns, with the same id, if a
  later version lists it again.
- The sync never touches an event's own state (overrides, holds, rates).

An event that already uses a property picks up new template units by choosing
the same property again ("Add any new units from the template").

## Model

| Table | What it is |
| --- | --- |
| `LodgingProperty`, `LodgingBuilding` | A property and its buildings or areas. |
| `LodgingUnit` | A room, a numbered RV site, or a counted area (`isArea`). Kind `ROOM`, `RV_SITE`, `TENT`. Floor, ground level, bathroom, linens, special use, assignable, default "sleeps up to" (null is no fixed limit), default unavailable, default hold, effective dates, optional rate `category`. |
| `LodgingBed` | One row per bed: queen, double, twin, twin bunk. |
| `EventLodging` | An event's one property, plus an optional night window. |
| `EventLodgingUnit` | Per-event state of a unit: capacity override and the unavailable flag. |
| `EventLodgingHold` / `EventLodgingHoldHistory` | Holds with reason, actor and window; append-only history. |
| `EventLodgingRate` | Optional per-category rate (see below). |

Sleeping counts: a queen or double sleeps 2, a twin 1, and a **twin bunk 2**
(a lower and an upper twin). That is what makes the recorded defaults come out:
a Forest Village cabin (4 bunks + 1 double) sleeps 10, Goldfinch 6, a Wildlife
Inn room (queen + bunk) 4, and the Man Camp check holds (33 queens and bottom
bunks in rooms with their own bathroom). A unit's explicit figure wins over its
beds (Boys 314-316, special use, hold 8; storage has 0).

### Seeded data (as recorded on #198)

- **Camp Heritage**: Wildlife Inn (6), Lakeview Lodge (Sunset, Starlight; held
  for the cooks), Generals Quarters, Four Seasons Cabins (4), Medicine Lodge
  (Nurses Room held for the nurse), Forest Village (6), Mountain Village (6),
  Goldfinch, Whippoorwill, and Shady Oak as two counted areas (20 full-hookup,
  20 without electricity). Camp Heritage House is never listed.
- **Sunnydale Academy**: Boys Dorm (1st floor 101-105 and 120-123, with
  106 and 107 as storage that is never assignable; 2nd 201-205, 207, 209-216;
  3rd 301-303, 305, 307-316), Girls Dorm (1st 101-108 from the legacy tool, 2nd
  201-205, 207, 211, 213-228, 3rd 301-305, 307, 311-318), the conference center
  (CC-01 queen sleeps 2, CC-02 two doubles sleeps 4, CC-1A and CC-1B one twin
  each), 18 RV sites (16 in the church lot, one by the conference center, one
  by the cafeteria), tents with power (a counted area, default 4) and tent camping
  (no fixed limit, no sites).
- Boys 121, 210 and 212 start **unavailable for every event** but stay in the
  inventory. Boys 314-316 are special use. Boys 302 is a double room with a private
  bath (recorded as one double bed, sleeps 2). Boys 121 is two doubles, sleeps 4.
  The Boys Dorm 1st-floor restroom has set hours that are not modeled.
- Not modeled yet (not enough data): which RV sites have hookups, and the Hall A
  and Hall B layout of the Girls Dorm.

## Per event

An event picks **one property** (`EventLodging`). It then gets a row per unit
with:

- a **capacity override** (null uses the default);
- an **unavailable** flag, which starts from the template's default;
- **holds**: whole-unit, for a window of nights (both ends inclusive), with a
  required reason, a kind (staff or maintenance), and the actor. A unit's default
  hold (the cooks' and the nurse's rooms) is placed once, for the event's whole
  window, when the property is chosen.

Holds are never deleted. Changing a window or releasing one appends a row to
the history (`CREATED`, `WINDOW_CHANGED`, `RELEASED`, each with actor, time and
details), and a released hold returns the unit to the inventory. Changes to a
unit and to rates are also in the audit log, with old and new values.

An event's property cannot be changed once chosen in this slice.

External hotel details live on the event (`hotelName` and friends) and are
never counted as on-site inventory; `LodgingUnitKind` has no hotel.

## Availability

Nights are calendar dates; a night's date is the evening it starts. By default
an event offers its first calendar day through the day **before** its last (the
last day is departure), in the event's own time zone. `EventLodging.firstNight`
and `lastNight` can narrow or widen that.

`projectAvailability` (`modules/lodging/domain.ts`) is pure and deterministic.
For each unit and night, the first match wins:

1. **NOT_ASSIGNABLE**: storage, or a retired unit;
2. **INACTIVE**: outside the unit's effective dates (`activeFrom`/`activeUntil`);
3. **UNAVAILABLE**: the unavailable flag (a closure);
4. **HELD**: an unreleased hold covers the night;
5. otherwise **AVAILABLE** with `capacity = override ?? default` (null: no fixed limit).

Out-of-service nights have capacity 0. `available = capacity - occupied`;
`occupied` is zero in this slice and is the input #200 supplies. `stayFit`
answers a partial stay (arrival and departure inside the window): every slept
night must be in service with room for the party.

## Concurrency and exclusivity

- A unit has at most one **unreleased hold on any night**, enforced by an
  exclusion constraint (`btree_gist`, `daterange` overlap per event unit), so
  racing requests cannot both win; the loser gets `HOLD_OVERLAP`.
- Holds and their history cannot be deleted or rewritten directly (triggers);
  they go only with their event or unit row.
- A unit row must come from the property its event chose, and children carry
  the event id in composite foreign keys, so they cannot cross events.
- Every change to a unit takes the `EventLodgingUnit` row lock (`FOR UPDATE`,
  in id order) through `lockEventLodgingUnits`. **#200 must take the same lock
  before it counts occupancy and allocates an exclusive unit**, and should add a
  similar exclusion constraint on its assignment table for night ranges.
- Actor columns are plain user ids with no foreign key, so history never has to
  be rewritten when a user is deleted.

## Optional lodging rates

Camp Meeting housing is priced; Camp Heritage club events are not (their
registration price includes lodging).

- **No rate means lodging is included or free**, and that is the default for
  every event. Templates and tests carry no prices.
- Categories: dorm room, conference center room, RV site, tent with power,
  tent. A unit carries its category (Sunnydale only; Camp Heritage units have
  none).
- A rate is `amountCents`, a basis (**per room or site per night**, or per
  person per night) and optional `minimumNights` (the legacy CM26 dorms
  required 4+). Dorm rooms are priced per room per night.
- **Tent with power shares the tent rate.** It stays its own inventory
  category (capacity 4) but has no rate of its own unless one is set;
  `rateForCategory` falls back from tent with power to tent (one way only).
- Only staff holding **MANAGE_FINANCE** can set or remove a rate (the
  `PUT .../lodging/rates` route and the rates section of the screen). Pricing
  changes are a human-gated action, so rates are only ever set by a person in
  the UI, never seeded. Each change is audited with the old and new values.
- `quoteStay` is a pure helper: category, nights, party size (and units) give
  `INCLUDED`, a `CHARGE` total, or `BELOW_MINIMUM_NIGHTS`. Per unit:
  amount x nights x units; per person: amount x nights x people. #199 shows the
  quote at selection; **charging it at registration is not wired** (see "Not in
  this slice").

## Access

Server-side on every route and on the page:

- Viewing inventory, choosing a property, capacity overrides, unavailable flags
  and holds: **CONFIGURE_EVENT** (event administrators and system
  administrators).
- Rates: **MANAGE_FINANCE**.

## Event clones and templates

Cloning an event copies configuration only, from an explicit list of domains,
and lodging is not on it: a clone starts with no property, holds, overrides or
rates, and never carries assignments (there are none yet). The cloned event
picks a property again.

## Preferences and roommate requests (#199, slice 2)

A **request** is what a guest asked for. It is separate from an assignment:
nothing in this slice places anyone in a unit, moves them, or starts a
waitlist (that is #200). The rules below come from the "Build scope for slice
2" comment on #199.

### Who chooses lodging

- **Man Camp and Camp Meeting**: registrants pick a lodging type (dorm room,
  conference center room, RV site, tent with power, tent) on their private
  registration page (`/manage/<token>`), after they register. The types
  offered are the categories that have at least one unit in service at the
  event's property.
- **Club events**: staff assign, so the event setting **Registrants choose a
  lodging type** stays off and nothing is collected.
- Per-event settings (`EventLodging`, set by **CONFIGURE_EVENT** on the
  requests screen and audited):
  - `collectsPreferences` (default off);
  - `preferencesDeadline`: the last day a registrant can change a choice,
    inclusive, in the event's time zone. Blank follows the event's registration
    close date, and with neither it is the day the event starts;
  - `fullBehavior`: `SHOW_FULL` (default) or `WAITLIST`. Both show "Full" in
    this slice; the waitlist itself is #200.
- The price shown at selection is `quoteStay` over the event's lodging rates
  (see "Optional lodging rates"). **Nothing is charged here**: adding lodging to
  the registration total, and payment, are not wired in this slice (see
  "Not in this slice").

### Data model

| Table | What it is |
| --- | --- |
| `EventLodgingRequest` | One per registration; points at its current version. |
| `EventLodgingRequestVersion` | Immutable snapshot: type, nights (both null is the whole event), party size, `groundFloorNeeded`, `accessibleRoomNeeded`, `privateRoomRequested`, household preference, source (`REGISTRANT`, `STAFF`, `REGISTRATION_FORM`), the form version, actor user or access token, change reason, and `afterDeadline`. |
| `EventLodgingRoommateRequest` | A directional "I would like to room with ...", from one registration to another (and optionally a person on each side), with the staff decision and the withdrawal. |
| `EventLodgingRule` | A staff keep-together, split or keep-apart rule with reason, actor, effective nights and an end (never a delete). |
| `EventLodgingReviewAck` | A staff acknowledgement of a review item. |

Every change to a request is a **new version**; the earlier ones are kept and a
trigger refuses rewriting or deleting them. Saving an identical request adds
nothing. The unique and cross-event rules are enforced by the database:

- a request's registration, and both registrations of a roommate request, must
  be on the request's event; a named person must be an attendee of that
  registration; a rule can name only people registered for the event;
- one open roommate request per pair of registrations and named people (a
  partial unique index; a withdrawn request is kept and the pair can ask again);
- a roommate request's parties and source cannot be rewritten; a decision or a
  withdrawal changes only its own columns, and a withdrawal is final;
- a rule can only be ended, once; acknowledgements are append-only;
- all of it goes with its event or registration, and only then.

### Privacy

- **Accessibility is two yes/no flags**: "ground floor needed" and "accessible
  room needed". No schema accepts free text for them (every input schema is
  strict, so an unexpected field such as `medicalReason` is refused), and no
  text or JSON column exists on the request tables apart from the staff
  `changeReason`. CM26's "first-floor request for medical reasons" is replaced
  by the flag alone.
- The flags are readable and settable only by staff with
  **VIEW_SENSITIVE_DATA**. Staff without it get no flag fields at all, cannot
  set them (an attempt is `SENSITIVE_DATA_FORBIDDEN`), and their edits carry the
  existing flags forward. The review queue's accessibility items are hidden from
  them and cannot be acknowledged by them.
- The audit log records **that** accessibility changed (`accessibilityChanged`),
  never the values.
- The protected-records projection (ADR 0005, #192) is not built yet. When an
  approved projection exists it may set one of these two flags; nothing from a
  protected record, and no medical text, is copied into lodging.
- **Roommate matching never exposes contact details.** A request names a
  registration; it carries no email, phone or address, and no view or export
  holds one. A registrant sees only their own outgoing requests, and only as
  matched, waiting or not matched: **nobody learns who asked to room with
  them**, and a one-sided request does not disclose that the other person even
  looked.

### Roommate requests

A registrant names someone **by name and confirmation code together**, or picks
a person on their own registration. A wrong name, a wrong code, a cancelled
registration and a registration on another event all give the same answer, so
the form cannot be used to find out which codes or names exist. The route is
rate limited per link like the other private-link edits.

A request counts as **mutual only when**:

1. both registrations ask (the other side's request is open and not declined);
   or
2. staff approve it (with a reason); or
3. it is between two people on the same registration (the registrant agreeing
   with themselves).

Until then it is one-sided and sits in the staff review queue. Staff can
approve, decline (final) or withdraw (with a reason), and the registrant can
withdraw their own request before the deadline.

### Households, keep-together and keep-apart

- **Default**: everyone on a registration is kept together.
- **Responsible adult (#131)**: a minor with an ACTIVE declared responsible
  adult is kept with that adult. This is derived from the guardian-authority
  records at read time (source: the declaration and its date), so it follows
  them when a declaration changes and never goes stale. A staff split does
  **not** override it; revoking the declaration does.
- **Staff rules** (`EventLodgingRule`, **MANAGE_REGISTRATION**): *Keep
  together* joins two people on different registrations, *Split from
  household* takes one person out of their registration's default group, and
  *Keep apart* says two people must not be placed together. Each keeps its
  reason, actor, optional first and last night, and, when ended, who ended it
  and why. Ended rules stay in the history.
- A person who moves to another registration (a substitution) is kept with
  their new household at once, because the groups are computed from the
  current registrations on every read.

### Deadline and changes

A registrant can create or change the request, and the roommate requests,
through the event's lodging deadline. After it they are told to contact the
event team. Staff can change a request at any time with a reason; a staff change
after the deadline is marked `afterDeadline` and listed in the review queue.
Every change, by anyone, is a new version with its actor or access token.

The registrant link route is open to lodging preferences even when the event's
edit policy is "verify every edit": a lodging choice is a category and two
yes/no boxes, in the same class as a seminar preference, and the deadline
bounds it. Identity answers are unaffected.

### Selecting a full type

At selection a registrant is refused a type that is full for the nights they
asked for, counted in **people** against the type's capacity night by night
(partial stays on other nights still fit; a type with no fixed limit never
fills). Selection takes the `EventLodgingUnit` row locks for the type's units
(`lockEventLodgingUnits`, the same lock #200 must take before it assigns), so
five registrants racing for the last place produce exactly one winner. Staff
are not stopped by "full"; the queue then shows the type as over capacity.

### The staff review queue

`getStaffLodgingRequestsView` builds it from current facts (nothing is
stored but the acknowledgements). It lists:

- one-sided roommate requests (approve or decline) and requests for a
  registration that is no longer registered;
- keep-apart rules that the household, responsible-adult or keep-together rules
  contradict, or that a mutual roommate pair contradicts;
- mutual roommates who asked for different types or share no night;
- nights outside the event's bookable nights, and a type with nothing in
  service;
- requests changed after the deadline;
- types with more people asking on some night than the type takes;
- accessibility items (hidden without VIEW_SENSITIVE_DATA), including a ground
  floor need in a type with no ground-level unit.

An item can be **acknowledged** with a note; its fingerprint changes when the
thing it is about changes, so a changed item comes back.

### Access (#199)

| Action | Permission |
| --- | --- |
| View requests and the review queue, edit a request, decide roommates, add or end rules, acknowledge | **MANAGE_REGISTRATION** |
| Read or set the accessibility flags | plus **VIEW_SENSITIVE_DATA** |
| Collection, deadline and "Full" settings | **CONFIGURE_EVENT** |
| Staff CSV export (`/api/events/<id>/exports/lodging-requests`) | **VIEW_REPORTS**; accessibility columns also need VIEW_SENSITIVE_DATA |
| Registrant request and roommate routes (`/api/public/manage/<token>/lodging`) | a valid private registration link, for that registration only |

### Export

The staff CSV holds only approved fields: confirmation code, lodging type,
first and last night, people, private room requested, household preference,
roommate counts (mutual and waiting), and last changed. It has **no names,
contact details, free text or restricted evidence**. The two accessibility
columns are present only for staff with VIEW_SENSITIVE_DATA.

## Checks

- Unit tests: `tests/lodging-domain.test.ts`, `tests/lodging-templates.test.ts`,
  `tests/lodging-routes.test.ts`, `tests/lodging-preferences-domain.test.ts`,
  `tests/lodging-preferences-routes.test.ts`.
- Real database: `npm run test:lodging` (`scripts/verify-lodging-inventory.ts`,
  local database only, wired into CI). It covers template sync idempotency and
  parallel runs, versioned retirement, event property choice, default holds,
  night-by-night availability with partial stays and closures, overrides, hold
  history, racing holds, the direct-delete refusals, hotel details, rates, audit
  rows, and cascade on event deletion.
- Real database: `npm run test:lodging-preferences`
  (`scripts/verify-lodging-preferences.ts`, local database only, wired into
  CI). It covers versioned requests and partial stays, the deadline (and the
  staff override flagged for review), a full type and five registrants racing
  for the last place, directional roommate requests (one-sided, mutual, staff
  approved and declined, the uniform lookup miss, no contact detail anywhere),
  the accessibility flags and who can see them, the audit log holding no flag
  values, household rules (responsible adult, split, join, keep apart, a person
  who changes household, history kept), the review queue and acknowledgements,
  the database refusing cross-event rows and rewrites, and cascade on
  registration and event deletion.

## Not in this slice

- **Charging at registration.** The price is shown at selection from the
  event's rates, but a lodging total is not added to the registration or sent
  to payment. Changing what a registration owes is a pricing action that a
  human should approve, so it is left open for #200 / a follow-up.
- **Choosing lodging inside the registration form itself.** Registrants choose
  on their private registration page right after registering (the private link they
  receive after registering). `sourceFormVersionId` and the `REGISTRATION_FORM` source
  are in the model for when the form submission writes the first version.
- Assignments, moves, the waitlist and the attendee room display (#200); the
  interactive site map (#779); staff editing of the property templates
  themselves (templates are code data).
- The protected-records projection of an accommodation action (#192, ADR 0005
  still Proposed): the two flags are the only accommodation data held.
