# Lodging inventory, availability, preferences and assignment (#198 slice 1, #199 slice 2, #200 slice 3)

Reusable lodging inventory for on-site properties, with per-event state and
night-by-night availability computed on the server. The inventory tables hold
**facility data only**: no person, assignment or waitlist, and no occupant names
from the source sheets. What guests *asked for* lives in separate tables (see
"Preferences and roommate requests (#199)" below) and is never an assignment;
assignments, moves, the waitlist and the attendee display are in "Assignment,
moves, waitlist and attendee display (#200)" below.

Code lives in `modules/lodging/`; the staff screens are **More > Lodging**
(`/more/lodging`, inventory), **More > Lodging requests**
(`/more/lodging/requests`, preferences and the review queue) and **More > Lodging
assignments** (`/more/lodging/assignments`, placing guests).

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

A template change never reaches a live event by itself (see "Layout snapshot"
below).

## Model

| Table | What it is |
| --- | --- |
| `LodgingProperty`, `LodgingBuilding` | A property and its buildings or areas. |
| `LodgingUnit` | A room, a numbered RV site, or a counted area (`isArea`). Kind `ROOM`, `RV_SITE`, `TENT`. Floor, ground level, bathroom, linens, special use, assignable, default "sleeps up to" (null is no fixed limit), default unavailable, default hold, optional rate `category`. `activeFrom`/`activeUntil` are **reserved for a later slice**: the columns exist and availability honours them, but no screen or template sets them yet. |
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
  inventory. Boys 314-316 are special use. Boys 302 is two connected rooms (2 twins
  each) sharing a bathroom, usually used by one large family: one assignable unit,
  4 twin beds, sleeps 4, private bath. Boys 121 is two doubles, sleeps 4.
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
  hold (the cooks' and the nurse's rooms) is placed when the property is
  chosen, as a *system-placed* hold covering the event's nights.

### Layout snapshot

When an event chooses a property, each unit's default capacity, bed summary,
assignable and retired state are copied onto its `EventLodgingUnit` row, and
availability reads that snapshot (an override still wins). A later template
version therefore never silently changes a live event's capacity. It reaches
an event only through the explicit, audited **Update to latest property
layout** action (`POST .../lodging/layout`, CONFIGURE_EVENT), which refreshes
the snapshots and adds units the template introduced, keeping overrides,
unavailable flags and holds. A unit the new layout drops is marked **Retired**
and stays visible while it still has an active hold; otherwise it is hidden.

### Default holds and the event's dates

System-placed default holds follow the event's nights. Choosing the property
again (the re-pick, which also applies a night window if one is given, and
refuses one that ends before it starts) moves them to cover the event's
current nights, with a history row each. A staff-placed hold is never moved.
Changing the event's dates does not do this by itself: the lodging screen
flags a default hold that no longer covers the event's nights and offers
"Extend to cover the event".

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
2. **INACTIVE**: outside the unit's effective dates (`activeFrom`/`activeUntil`, reserved: nothing sets them yet);
3. **UNAVAILABLE**: the unavailable flag (a closure);
4. **HELD**: an unreleased hold covers the night;
5. otherwise **AVAILABLE** with `capacity = override ?? default` (null: no fixed limit).

Out-of-service nights have capacity 0. `available = capacity - occupied`;
`occupied` (the people assigned to the unit that night, zero before any assignment) is the input #200 supplies. `stayFit`
answers a partial stay (arrival and departure inside the window): every slept
night must be in service with room for the party.

## Concurrency and exclusivity

- A unit has at most one **unreleased hold on any night**, enforced by an
  exclusion constraint (`btree_gist`, `daterange` overlap per event unit), so
  racing requests cannot both win; the loser gets `HOLD_OVERLAP`.
- Holds and their history cannot be deleted directly, and event lodging and
  unit rows cannot be deleted while the event exists (triggers). They go only
  with the event, from inside the foreign-key cascade once the event is gone.
  Hold history is never rewritten; a hold changes only its window and release
  fields, and a released hold never changes again.
- A unit row must come from the property its event chose (also enforced when
  an event's property, a unit's property or a unit's building changes), and children carry
  the event id in composite foreign keys, so they cannot cross events.
- Every change to a unit takes the `EventLodgingUnit` row lock (`FOR UPDATE`,
  in id order) through `lockEventLodgingUnits`. The assignment writers (#200) take
  the same lock before they count occupancy, and the assignment table has an
  exclusion constraint on night ranges per occupant.
- **Lock order** is always: unit rows (id order), then `EventLodging`
  (`touchEventLodgingCapacity`). That includes `selectEventProperty` when it
  applies a new window, and waitlist promotion and reinstatement of a registration
  that holds a request (`noteLodgingOnAdmission`).
- **`EventLodging.capacityVersion` makes a stale reader fail.** The registration
  submission is Serializable and reads capacity from several tables. A writer that
  runs at Read Committed (a private-page save, a staff save, an override, a hold)
  cannot make a Serializable reader fail by taking row locks alone: the reader
  would simply see its old snapshot. So **every writer of lodging capacity or
  demand** takes the unit row locks (`lockEventLodgingUnits`) and then calls
  `touchEventLodgingCapacity`, which bumps `capacityVersion` on the event's
  `EventLodging` row inside its own transaction (`selectEventProperty`,
  `updateEventLayout`, `updateEventUnit`, `createHold`, `changeHold`, and every
  request save). The submission locks the units and then reads and bumps that row
  (`FOR UPDATE`), so a submission that raced a save for the last place either
  waits and then sees the place gone, or fails its Serializable check and is retried
  (and told the type is full). Every assignment writer (#200) does the same, and
  any new capacity writer must: lock the units, then `touchEventLodgingCapacity`.
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
- A rate is `amountCents`, a basis and optional `minimumNights` (the legacy
  CM26 dorms required 4+). Four bases:
  - **per room or site per night** (`PER_UNIT_NIGHT`) and **per person per
    night** (`PER_PERSON_NIGHT`), for Camp Meeting housing (dorm rooms are per
    room per night);
  - **per room or site for the whole event** (`PER_UNIT_PER_EVENT`) and **per
    person for the whole event** (`PER_PERSON_PER_EVENT`), flat amounts that do
    not grow with the nights, for Man Camp, where the registration price differs
    by housing choice. A minimum number of nights can still be set on them.
- **Tent with power shares the tent rate.** It stays its own inventory
  category (capacity 4) but has no rate of its own unless one is set;
  `rateForCategory` falls back from tent with power to tent (one way only).
- Only staff holding **MANAGE_FINANCE** can set or remove a rate (the
  `PUT .../lodging/rates` route and the rates section of the screen). Pricing
  changes are a human-gated action, so rates are only ever set by a person in
  the UI, never seeded. Each change is audited with the old and new values.
- `quoteStay` is a pure helper: category, nights, party size (and units) give
  `INCLUDED`, a `CHARGE` total, or `BELOW_MINIMUM_NIGHTS`. Per unit per night:
  amount x nights x units; per person per night: amount x nights x people; flat
  per unit: amount x units; flat per person: amount x people. #199 shows the
  quote at selection and **charges it with the registration** (see "Charging").

## Access

Server-side on every route and on the page:

- Viewing inventory, choosing a property, capacity overrides, unavailable flags
  and holds: **CONFIGURE_EVENT** (event administrators and system
  administrators).
- Rates: **MANAGE_FINANCE**.

## Event clones and templates

Cloning an event copies configuration only, from an explicit list of domains,
and lodging is not on it: a clone starts with no property, holds, overrides or
rates, and never carries assignments, expected guests, housing choices or waitlist
entries (those belong to the event and are not on the list). The cloned event
picks a property again. `npm run test:event-cloning` checks that a clone of an
event that uses a property carries none of it.

## Preferences and roommate requests (#199, slice 2)

A **request** is what a guest asked for. It is separate from an assignment:
nothing in this slice places anyone in a unit, moves them, or starts a
waitlist (that is #200, below). The rules below come from the "Build scope for
slice 2" comment on #199.

### Who chooses lodging

- **Man Camp and Camp Meeting**: registrants pick a lodging type (dorm room,
  conference center room, RV site, tent with power, tent) **in the public
  registration form**, in a lodging step before review, and can change it later
  on their private page (`/manage/<token>`) under the event's edit policy. The
  types offered are the categories that have at least one unit in service at the
  event's property.
- **Club events**: staff assign, so the event setting **Registrants choose a
  lodging type** stays off and nothing is collected.
- Per-event settings (`EventLodging`, set by **CONFIGURE_EVENT** on the
  requests screen and audited):
  - `collectsPreferences` (default off);
  - `preferencesDeadline`: the last day a registrant can change a choice,
    inclusive, in the event's time zone. Blank follows the event's registration
    close date, and with neither it is the day the event starts;
  - `fullBehavior`: `SHOW_FULL` (default) or `WAITLIST`. Both show "Full" at
    selection; with `WAITLIST` a guest can join the lodging waitlist from their
    private page (#200).
- The price shown at selection is `quoteStay` over the event's lodging rates
  (see "Optional lodging rates"); it is added to the registration total (see
  "Charging").

### The lodging step of the registration form

The step is part of the registration form, built the way the form's other
non-field parts are (like the responsible-adult choice): the form's step plan
adds a **Lodging** step before review (`getPublicRegistrationStepPlan(...,
{ lodging: true })`), its answers travel beside the form's own as `lodging` in the
submission, and the server decides them inside the registration's transaction.

- **Shown only** on an individual registration at an event with
  `collectsPreferences`. Club and group registrations never show it (the page
  does not pass the offer, the component ignores it for club and group props, and
  the server refuses a `lodging` on a club or group submission).
- **A registration that joins the waitlist** still sees the step, but nothing is
  priced and a full type or a stay under a minimum is not a problem yet. The server
  keeps the choice as an **unpriced request** (version 1, source
  `REGISTRATION_FORM`, no capacity check, no line) and the confirmation says "Your
  lodging choice is saved; the event team will confirm it if a place opens". The
  charge is added later, in Payments, if a place opens.
- **What it asks**: type (a type that is full for the chosen nights and people is
  shown as Full and cannot be picked), first and last night, how many of the
  registration's attendees are staying, private room, whether the party can be
  split, the two yes/no accessibility boxes ("No medical details" is stated),
  and roommate requests (by name plus confirmation code, or between two people on
  the registration).
- **On submit** (`planRegistrationLodging`): the nights, party and type are
  checked, **every unit row of the event's lodging is locked** (the same
  `lockEventLodgingUnits` the later steps take) and `capacityVersion` is bumped, a full type is refused with a
  field error on the `lodging` key that starts "Lodging step:", and a stay under a
  rate's minimum is refused. The submission transaction is Serializable, so two
  registrants racing for the last place leave one winner (the loser is retried
  and then told the step is full). A refusal rolls everything back: no
  registration, person, payment claim or lodging row is left behind.
- Then, once the registration and attendees exist (`recordRegistrationLodging`),
  version 1 of the request is written with source `REGISTRATION_FORM` and the
  form version id, with the roommate requests (source `REGISTRATION_FORM`) and an
  audit entry, all in the same transaction. A roommate who cannot be found is a
  field error on the step (same uniform message). A submission that asks to room
  with someone **by name and confirmation code** also spends a tighter budget (10
  per client and 5 per client and form every 15 minutes) on top of the registration
  budget. A miss rolls the submission back, so it is **audited outside the
  transaction**, by the hashed client and the form only (`LODGING_ROOMMATE_LOOKUP_MISSED`;
  never the typed name or code). A submission that carries lodging uses
  `lodgingTransactionTimeoutMs` (explicit timeout and maxWait) because it locks
  every unit and may look roommates up.

### Charging

The lodging price is added to the registration's priced total through the
registration's own calculation, as **its own line labelled "Lodging: <type>"**
(key `lodging`, no attendee, with a note such as "$25.00 per room or site per
night, 3 nights"):

- `lodgingCharge` (`modules/lodging/pricing.ts`) turns a type, nights, party and
  the event's rates into the line. **No rate means no line**: a type without a
  rate adds nothing (Camp Heritage club events, or any unpriced type). Nothing is
  seeded; staff enter every amount, and only MANAGE_FINANCE can.
- **Rooms for a party.** A per-room (or per-site) rate is charged for
  `ceil(partySize / the type's room size)` rooms, where the room size is the
  smallest capacity among the event's rooms of that type (a party of 6 in 2-person
  dorm rooms pays for 3 rooms, and the line reads "Lodging: Dorm room (3 rooms)").
  Only ROOM-kind units count this way; an RV site or a tent is one unit. A
  per-person rate counts people, never rooms. *Caleb: this is the rule as built;
  tell us if the group should pay for one room instead.*
- `calculationWithLine` and `addUndiscountedLine` (in the form definition module) add the line to the form's
  own calculation, so the **processing fee follows the new subtotal** exactly as
  it does for the form's own lines. The browser prices the same way for the running
  total and the review step; the server prices again and its numbers win.
- Because the line is in the pricing snapshot, it reaches the confirmation, the
  confirmation email, the private page's order, the payments page and the card
  payment amount (all read the snapshot or the registration total) with no other
  wiring. An **amendment** of the form's answers carries the stored lodging line
  through unchanged instead of repricing it away.
- **Promo codes do not discount lodging** (until the event team decides
  otherwise). The discount and a code's minimum are worked out on the form's own
  lines; the lodging line is added afterwards (`addUndiscountedLine`), and the
  processing fee follows the final subtotal. This holds for the quote endpoint
  (given the same `lodging` choice), the submission and amendments, for a
  registration-level and a per-person code alike, including a church-sponsored code.
  A church-billed event (deferred organization invoice) bills through its invoice:
  lodging is recorded but never priced into the registration, and its expected
  lodging charge is 0 everywhere, including the review queue.
- **After submission the charge is never changed by a lodging edit.** Nothing
  reprices, and nothing creates a payment, a refund or a new charge by itself.
  Whether an edit "changes the charge" is decided by pricing the previous and the
  new request at the **same current rates**: a rate change alone, or an edit that
  is not about price, is not a charge change.
  - A **registrant's** change that would alter the charge is recorded as a change
    request ("Lodging charge change requested: +$X / -$Y") and the total stays
    as it was. A staff member makes the change if it is right.
  - A **staff** change is saved and marked `priceNeedsReview` with the charge
    difference; the screen says so and links to Payments (`/finance?event=<id>`),
    where the charge is adjusted with the existing adjustment flow.
  - The review queue lists **Lodging charge differs from the request** when the
    charge on the registration no longer matches the request at today's rates
    (for example after a rate change). It is a queue item only.
  - A registration that never went through a form (an import) has no stored
    pricing: its request is applied unpriced and listed the same way.

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
- a rule can only be ended, once; acknowledgements are append-only; a staff
  decision on a roommate request is final and the link a request came through
  is frozen;
- person ids on roommate requests and rules are foreign keys to `Person` with
  `ON DELETE RESTRICT`, like the guardian-authority records. Nothing in the
  product deletes a person today (club erasure removes roster rows); if a
  person-erasure feature is added it must end or anonymize their rules and
  roommate requests first, because a rule's CHECK needs both people;
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
- The audit log records **that** accessibility changed on an existing request
  (`accessibilityChanged`), never the values, and does not record whether a first
  request set them. Acknowledging a restricted item stores a generic note and a
  generic audit entry (no kind, key or typed note).
- Staff without VIEW_SENSITIVE_DATA also cannot infer the flags from the version
  history: a version that changed only the flags is left out, version numbers
  and the "last changed" time are counted over what they can see, and change
  reasons (free text) are not shown. The reason and note fields say "No medical
  details".
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
rate limited per link like the other private-link edits, and a lookup by name
and code has its **own, tighter budget**: 5 per link, 5 per link and client,
and 10 per client every 15 minutes. Each miss is audited with the registration
id, the link and a running count for the hour, never the typed name or code, so
a pattern of guessing is visible to staff. (The registrant's own list does show
a request as "matched" once the other side has asked back or staff approved,
because by then both people named each other; it never says who asked for them.)

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

### The event's edit policy on the private link

Lodging follows the same `attendeeEditPolicy` as every other private-link edit.
This is the rule until the event team rules otherwise:

- **VERIFY_EVERY_EDIT** (the default): the lodging section on `/manage/<token>`
  is **read-only** (like the responsible-adult section). The request and
  roommate routes refuse on the server with `EDIT_POLICY_REQUIRES_VERIFICATION`
  ("This event requires verification before this change. To change this, contact
  the event team."). Staff can still record a request for the guest.
- **TIERED**, following `isTieredAttendeeFieldEditable` (sensitive and priced
  answers are not self-service):
  - the **accessibility flags** may be set by the **first saved version** only;
    a registrant changing them afterwards is refused with `FLAGS_STAFF_ONLY`
    and the section tells them to contact the event team (the form stops sending
    them once locked);
  - a **change that alters the lodging charge** (a different priced type, or
    different nights or party on a priced type) is **never applied by a
    registrant** once the registration is submitted. It is recorded as an open
    `EventLodgingChangeRequest` (category, nights, party, private room, household;
    never the flags), the registrant is told it went to the event team, and the
    review queue shows **Change requested** with the signed amount. A staff save
    for that registration resolves it. Changes that leave the charge unchanged (a
    type with no rate, the other preferences) stay self-service. This is the
    simplest safe rule: money already on the registration is never silently
    re-priced, and a decrease is a refund, which only a human issues.
- Roommate requests carry no price or sensitive data, so under TIERED they stay
  self-service until the deadline.
- **Individual registrations only.** Club and group registrations are refused in
  the service (`REGISTRATION_NOT_ELIGIBLE`), for registrants and staff, and are
  not listed or findable as roommates: their directors' rosters are placed by staff.
- A registrant is refused fewer nights than a rate's `minimumNights`
  (`BELOW_MINIMUM_NIGHTS`); staff may make the exception.

### Selecting a full type

At selection a registrant is refused a type that is full for the nights they
asked for, counted in **people** against the type's capacity night by night
(partial stays on other nights still fit; a type with no fixed limit never
fills). The check runs only when the change asks for more than it replaces: a
different type, a bigger party, or a night the earlier request did not cover
(so a registrant can still adjust a request that is already inside a type that
has since filled). Selection takes the `EventLodgingUnit` row locks for **every
unit of the event's lodging**, before any capacity is read
(`lockEventLodgingUnits`, the same lock the assignment writers take), so
five registrants racing for the last place produce exactly one winner. Staff
are not stopped by "full"; the queue then shows the type as over capacity.

### The staff review queue

`getStaffLodgingRequestsView` builds it from current facts (nothing is
stored but the acknowledgements). It lists:

- one-sided roommate requests (approve or decline) and requests for a
  registration that is no longer registered;
- keep-apart rules that the household, responsible-adult or keep-together rules
  contradict, or that a mutual roommate pair contradicts (a registration whose
  request says the party is FLEXIBLE is not joined into one group by the
  household default);
- a request whose party is larger than the registration's active attendees (people were removed after the request);
- mutual roommates who asked for different types or share no night;
- nights outside the event's bookable nights, and a type with nothing in
  service;
- requests changed after the deadline;
- types with more people asking on some night than the type takes;
- changes a registrant asked for that the edit policy held for staff;
- accessibility items (hidden without VIEW_SENSITIVE_DATA), including a ground
  floor need in a type with no ground-level unit.

An item can be **acknowledged** with a note; its fingerprint changes when the
thing it is about changes, so a changed item comes back.

### Access (#199)

| Action | Permission |
| --- | --- |
| View requests and the review queue, edit a request, decide roommates, add or end rules, acknowledge | **MANAGE_REGISTRATION** |
| Read or set the accessibility flags | plus **VIEW_SENSITIVE_DATA** |
| Collection, deadline and "Full" settings | **CONFIGURE_EVENT** (the response carries only the result unless the caller also holds MANAGE_REGISTRATION) |
| Staff CSV export (`/api/events/<id>/exports/lodging-requests`) | **VIEW_REPORTS**; accessibility columns also need VIEW_SENSITIVE_DATA |
| Registrant request and roommate routes (`/api/public/manage/<token>/lodging`) | a valid private registration link, for that registration only, subject to the event's edit policy; the view is on the `read` rate budget, saves on `update` |

### Export

The staff CSV holds only approved fields: confirmation code, lodging type,
first and last night, people, private room requested, household preference,
roommate counts (mutual and waiting), and last changed. It has **no names,
contact details, free text or restricted evidence**. The two accessibility
columns are present only for staff with VIEW_SENSITIVE_DATA.

## Assignment, moves, waitlist and attendee display (#200, slice 3)

Staff place guests in rooms, sites and alternate housing; every placement, move and cancellation is kept; a full type can
have a waitlist; attendees see their approved room once staff publish it; and staff get rooming lists and occupancy by
night. The rules below come from the "Build scope for slice 3" comment on #200. **Nothing here ever changes a
registration's charge, sends a bulk message, or refunds anything.** Code: `modules/lodging/assignment-*.ts`,
`waitlist-service.ts`, `notices.ts`; the staff screen is **More > Lodging assignments**
(`/more/lodging/assignments`).

### Data model

| Table | What it is |
| --- | --- |
| `EventLodgingAssignment` | The **current** placement of one occupant for a range of nights (both ends inclusive): in an on-site unit (`eventLodgingUnitId`) or an alternate-housing bucket (`bucketId`), with `people` (1 for an attendee, the head count for an expected guest), `source` (`STAFF`, `PROPOSAL`, `CSV_IMPORT`, `WAITLIST`), a `revision` that every change raises, and who/why. Cancelled rows stay (`cancelledAt`, `cancelReason`) and never change again. |
| `EventLodgingAssignmentHistory` | **Append-only**: one row per assignment event (`ASSIGNED`, `MOVED_IN`, `MOVED_OUT`, `SPLIT_REMAINDER`, `CANCELLED`, `TRANSFERRED_IN`, `TRANSFERRED_OUT`, `LATE_ARRIVAL`, `EARLY_DEPARTURE`, `LINKED`), with actor, reason, source, the place and nights before and after, whether capacity was deliberately kept, and the paired row of a move or transfer. |
| `EventLodgingBucket` | The five alternate-housing choices (Hotel, Airbnb, Home, Offsite, Other; staff rename the label). They count as placed and use no inventory. Created when an event chooses its property (and backfilled by the migration). |
| `EventLodgingPlaceholder` | An expected guest or group (staff, a pastor, a club) not registered yet, with a head count. It can be assigned, and a single guest can later be **linked** to a registration attendee (once). |
| `EventLodgingWaitlistEntry` / `EventLodgingWaitlistHistory` | The lodging waitlist (below) and its append-only history. |
| `EventLodgingAssignmentNotice` | A room notice staff sent one registration, with the assignment version it described. |

`EventLodging` gains `showAssignmentsToAttendees` (default **off**), `showRoommateFirstNames` (default **off**) and
`attendeeInstructions`. The `MessageTemplateKey` enum gains `LODGING_WAITLIST_OFFER` and `LODGING_ASSIGNMENT_NOTICE`
(not editable event templates, like the invoice email).

The database enforces what can be enforced there, following the hold and request patterns:

- an **exclusion constraint** (`btree_gist`) on the occupant and the night range: one person is never in two places on
  one night, even for a writer that skipped the service;
- exactly one place and at least one occupant; ordered nights; a reason once cancelled; an attendee must be on the
  assignment's event (and the unit and bucket, by composite foreign keys);
- every change to an assignment must raise `revision` **and append its history row in the same transaction** (a deferred
  constraint trigger refuses the commit otherwise); a cancelled assignment never changes again;
- history, notices and waitlist history cannot be rewritten; **no row in these tables can be deleted while its event
  exists**. They go only with the event: the foreign-key cascade once the event is gone, or the event deletion
  service's own explicit deletes (it sets the transaction-local `imsda.event_deletion` setting, as for the registration
  ledgers). The keys to registrations and attendees are `NO ACTION`, so a registration that holds a room, a waitlist
  entry or a notice cannot be deleted on its own: its history is kept;
- a waitlist entry moves only along the lifecycle (below), its ask never changes, there is one open entry per
  registration (partial unique index), and each state change appends its history row.

### Capacity and concurrency (night by night)

Every assignment writer takes the `EventLodgingUnit` row locks for the event's whole lodging (id order, through
`lockEventLodgingUnits`), then bumps `capacityVersion` (`touchEventLodgingCapacity`), then reads the current assignments
and plans against them. `planPlacements` (`assignment-domain.ts`, pure) works on an in-memory copy, so a batch cannot
overbook a unit with itself and a refused batch writes nothing. Capacity counts **people per unit per night** against the
event's override or default; a held, unavailable, retired or not-assignable unit blocks assignment on those nights; a
special-use room needs the staff member's confirmation. `npm run test:lodging-assignment` races five placements for the
last bed (one wins), one person into two rooms (one room), and a closure against an assignment, and it **fails when the
locks and the version bump are removed**.

- **Partial stays**: two people can share one bed on different nights.
- **Moves**: a move takes over a range of nights. The old row keeps the nights before, a `SPLIT_REMAINDER` row keeps the
  nights after (same place), and a `MOVED_IN` row holds the new place; capacity follows night by night.
- **Late arrival / early departure**: the nights given up are released, or kept held (`keepCapacity`), which only the
  history records. **Cancellation** releases the whole stay or some nights.
- **Transfer**: the place passes to another occupant (a substitute attendee, or a placeholder group), the old row ends
  and a new one starts with the capacity effect checked. A **placeholder link** carries the placement to the attendee.
- **A room closed, held or lowered after people were placed** is never changed silently: the assignments stay, and the
  workspace and reports list the conflict (night by night, drilling to the assignments). A **cancelled registration's
  room stays counted** until staff press "Release rooms of inactive registrations" (with a reason and history): capacity
  is only ever released on purpose.
- Registrant choices (#199) are still counted against *requests*, not assignments: staff assignment is the authority for
  rooms, and a registrant's "Full" reflects what guests asked for. (Counting assignments there is a later change.)

### The staff workspace

Rebuilt from the legacy CM26 housing tool, on the server: building and floor choices and a **hall layout** (odd rooms
left, even rooms right of the corridor), room status in words (available, partly filled, full, over capacity, held,
unavailable, not assignable), **drag and drop plus select-then-"Assign here" for keyboards and touch**, "Assign the next
unplaced person", "Fill this room", "Place the whole household here", move, cancel, late arrival and early departure,
transfer, a colour per household (with the confirmation code beside it), split-household and keep-apart warnings, a
warning before a special-use room, expected guests, alternate housing, search, and Not placed / Placed filters. Related
household members are the keep-together groups of #199 (registration, responsible adult, staff rules).

### Proposal and CSV import (preview first)

Both go through `POST .../lodging/assignments/plan`. `mode: "preview"` writes, locks and queues nothing and returns the
outcome of every row and a fingerprint of exactly what would happen. `mode: "apply"` needs that fingerprint and, under
the same locks as every writer, rebuilds the plan from scratch: if anything differs (someone placed a person, a room was
held, the file changed) it refuses with `PLAN_CHANGED` and writes nothing. The fingerprint covers the **whole plan**: every
row's outcome, each assignment it would release (id, revision and the range kept) and each one it would create, so a
colleague's move made between preview and apply (even of a row the file lists as unchanged) is refused as stale. A CSV with any problem row is refused whole
(`IMPORT_HAS_PROBLEMS`).

- **Proposal** (`proposeAssignments`, deterministic): households first (largest and accessibility-needing first), the
  requested category honoured (no request: a room, never a site or tent), ground-level units for ground-floor needs, the
  smallest unit that fits, keep-apart people never together, held, unavailable and special-use rooms never proposed, a
  household never split to make it fit (it is reported as not placed). It reads accessibility flags **only for staff
  with VIEW_SENSITIVE_DATA**; for others it runs without them. A proposal is never applied by itself.
- **CSV**: the assignments export is the file the import reads (Occupant ID, Place key `unit:<key>` or
  `bucket:<kind>`, First night, Last night; names are ignored). Anyone listed is *moved* there for those nights.

### The lodging waitlist

For events set to **Show "Full" and let guests join a waitlist**. Lifecycle (the database enforces the same moves):
`JOINED` → `OFFERED` (with an expiry) → `ACCEPTED` / `DECLINED` / `EXPIRED`; `EXPIRED` → `OFFERED` again (the next offer
number); `ACCEPTED` → `PROMOTED` (staff place the party in a unit); any open state → `REMOVED`.

- **Joining**: staff add a registration, or a registrant joins from the private page when the type is full for their
  nights (not when it still has room, not under "verify every edit", not after the lodging deadline).
- **Offers are explicit and idempotent.** An offer (MANAGE_REGISTRATION plus CONFIGURE_EVENT) is a **preview** until
  `confirm` is true; the preview names who would be emailed (masked address) and why an entry is not eligible. A confirmed
  offer queues **one email per entry** through the existing outbox (`LODGING_WAITLIST_OFFER`, the event's sender and
  delivery mode, the private-link sentinel, no price), a batch is capped at 25, and offering an entry that already holds
  a live offer returns it without another email. Nothing offers or promotes on its own, and a freed room never promotes
  anyone by itself. The **preview is read-only** (no locks, no capacity version bump); only a confirmed offer locks. If
  email delivery is turned off for the event, nothing is offered (the entry is skipped with the reason), so the offer
  clock never runs without an email. The workspace shows the **offer email's outbox status**; a live offer whose email
  failed, was suppressed or cancelled is flagged and can be offered again. Re-offering an expired entry while a newer
  open entry exists for the registration is refused as `WAITLIST_ALREADY_OPEN`.
- **A live offer reserves its places** (and so does an accepted entry) against the room that is free in its category, night
  by night, so one place cannot be offered twice; an expired offer holds nothing. An answer after the expiry records the
  expiry and is refused ("expired"); accepting, declining and promoting twice return the first outcome.
- **Promotion** is the placement: staff choose the unit and the party's attendees, and the normal capacity checks run
  under the unit locks. The history shows joined, offered, expired, offered, accepted, promoted.

### What attendees see

On the private registration page, **only after staff publish assignments** (the event switch, off by default): the
approved building (or area), room, nights and the event's instructions for each person on that registration; a person in
alternate housing sees its label ("Hotel, arranged outside the property"). **Roommates are shown by first name only, only
when staff turn that on, only adults of other registrations** (a child, an unknown age, an expected guest and members of
the same registration are counted, never named), and **never a last name, email, phone or confirmation code**. A
cancelled registration sees nothing. The same page shows the waitlist state and lets a guest accept or decline a live
offer. Staff can send one registration its **room notice** (MANAGE_REGISTRATION plus CONFIGURE_EVENT, one at a time, only
when assignments are published): it is **versioned** (the registration's assignment version is the count of its history
rows), sending again at an unchanged version queues nothing new, a later change makes it **obsolete** (listed for
closeout and sendable again), and a notice not yet delivered is **cancelled** by the change. A notice also records a
**content hash** of what it said (rooms, nights, building, bucket labels, roommate first names, closed-room flags and the
arrival instructions), so it goes obsolete when a roommate moves in or out, a room closes, a bucket is renamed or the
instructions are edited, not only when the registration's own assignments change. The notice is **checked again just
before it is sent** (like an invoice email): one that a later change made wrong, or a waitlist offer that is no longer
open, is cancelled instead of delivered. The private page and the notice load only that registration's own rows (and the
other occupants of its rooms when roommates are on), never the event's whole picture.

An amendment that **removes an attendee** with any room assignment history (even a cancelled assignment or an expected
guest linked to them) is refused with `ATTENDEE_HAS_HISTORY`; staff release or cancel the room from Lodging first.

### Reports

All built from the same facts as the workspace, so a number on one screen is the number on the others
(`getRoomingReports`): the **rooming list**; **occupancy by night** (capacity, placed, free, rooms in service, people in
housing elsewhere, and people still placed in a room closed or held after they were placed, flagged) drilling to the assignments behind each unit-night; **not placed** and **conflicts** (over capacity,
room closed after assignment, split household, keep-apart sharing, ground floor needed but placed upstairs); **key hand-off
inputs** (room, people, arrival, departure, the name on the registration, never a contact detail; key issuance itself is #80);
and **closeout exceptions** (rooms held by inactive registrations, open waitlist entries, obsolete notices, expected
guests not yet linked). Each has a CSV (`/api/events/<id>/exports/lodging-assignments?report=assignments|occupancy|unassigned|conflicts|closeout|keys`),
written by the shared CSV writer, so spreadsheet formulas are defused.

### Access (#200)

| Action | Permission |
| --- | --- |
| The workspace, place, move, cancel, stay changes, transfer, release inactive, expected guests, housing choices, proposal and CSV preview and apply, waitlist join, accept, decline, remove, record lapsed offers | **MANAGE_REGISTRATION** |
| Show assignments to attendees, roommates, instructions; send a room notice; **offer** waitlist places (even the preview); **promote** from the waitlist | **MANAGE_REGISTRATION** plus **CONFIGURE_EVENT** |
| The reports view | MANAGE_REGISTRATION or VIEW_REPORTS |
| CSV exports | **VIEW_REPORTS** |
| Accessibility flags and "ground floor needed" conflicts, on screen, in reports and in the CSV | plus **VIEW_SENSITIVE_DATA** (without it no flag field is sent at all) |
| Registrant waitlist route (`/api/public/manage/<token>/lodging/waitlist`): join, accept, decline | a valid private registration link, for that registration only; rate limited like the other private-link edits |

Every audit entry carries counts and ids, no names, and never an accessibility value.

## Checks

- Unit tests: `tests/lodging-domain.test.ts`, `tests/lodging-templates.test.ts`,
  `tests/lodging-routes.test.ts`, `tests/lodging-preferences-domain.test.ts`,
  `tests/lodging-preferences-routes.test.ts`, `tests/lodging-registration-form.test.ts`
  (every rate basis, the lodging line, rooms for a party, lodging never discounted by a promo code, the form's step and submission).
- Real database: `npm run test:lodging` (`scripts/verify-lodging-inventory.ts`,
  local database only, wired into CI). It covers template sync idempotency and
  parallel runs, versioned retirement, event property choice, default holds,
  night-by-night availability with partial stays and closures, overrides, hold
  history, racing holds, the direct-delete refusals, hotel details, rates, audit
  rows, and cascade on event deletion.
- Unit tests for slice 3: `tests/lodging-assignment-domain.test.ts` (the planner:
  assign, move and split, cancel, late arrival and early departure, transfer, held,
  unavailable and special-use rooms, partial stays, a batch that cannot overbook
  itself, warnings, conflicts, occupancy by night, the proposal, the CSV import and
  the waitlist rules), `tests/lodging-assignment-routes.test.ts` (every staff route's
  permission, the publish/offer/promote pair, sensitive-flag scoping, the registrant
  waitlist route) and `tests/lodging-assignments-workspace.test.ts` (the workspace and
  the attendee display: keyboard and touch alternatives to dragging, status in words,
  no restricted flag or contact detail).
- Real database: `npm run test:lodging-assignment`
  (`scripts/verify-lodging-assignment.ts`, local database only, wired into CI). It
  covers placement with history, audit and the capacity version; five staff racing
  for the last bed, one person raced into two rooms and a closure raced against an
  assignment (and it fails when the locks are removed); partial stays; held,
  unavailable, storage and special-use rooms; moves that split a stay and follow
  capacity night by night; cancellation, late arrival and early departure that
  release or keep capacity; transfer; a room closed or lowered after assignment;
  alternate housing and expected guests (head count, link, archive); keep-together
  and keep-apart warnings; accessibility flags on screen, in the reports and in the
  CSV; the proposal and the CSV import (preview writes nothing, apply only what was
  previewed, a changed plan or a bad file refused); occupancy by night reproduced
  and drilled to assignments; the waitlist (join, preview then one email per offer
  through the outbox, idempotent offers, reserved places, expired offers, accept,
  decline, promote, remove, every other move refused by the database); the
  attendee display and roommates by first name; room notices that become obsolete
  and are cancelled when not yet sent; no change to any registration's charge; the
  database refusing rewrites, deletes and cross-event rows; and every row going
  with its event, including through the event deletion service.
- Built app: `npm run test:lodging-assignment-http` (`scripts/verify-lodging-assignment-http.ts`,
  local only, run in CI beside the other public HTTP suites). Through the real
  routes and the real private page it checks that a published room and a roommate's
  first name are shown, that nothing is shown before publishing, that no surname,
  email, phone or confirmation code of the roommate reaches the page, that the
  registrant waitlist route needs a private link and the same origin and cannot
  offer or promote, and that every staff route and page refuses a signed-out caller.
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
  registration and event deletion; and, through the real public submission, the
  lodging step: the first version from the form, a charge for each rate basis,
  no line for an unpriced type, rooms for a party, a full type refused at submit
  (and five racing submissions leaving one winner, and a submit racing a
  private-page save for the last place), a church-billed event never charged at submit or
  after a save, a waitlisted submission keeping an unpriced request, lodging never
  discounted by a promo code (including a church-sponsored one), a registrant's
  charge change becoming a change request with the total unchanged, staff changes
  flagged for Payments, a rate change alone not being a charge change, and a party
  larger than the registration reaching the queue.

## Not in this slice

- Pricing lodging for a **waitlisted** registration: its choice is kept as an
  unpriced request, and staff add the charge in Payments if a place opens.
  **Promotion can be automatic** (a freed seat promotes the next waiting
  registration, or staff promote or reinstate one). Promotion never waits on
  lodging, never changes the request and never charges. It takes the event's unit
  locks and bumps `capacityVersion` (the request counts as demand again), and the
  review queue lists **Promoted from the waitlist with an unconfirmed lodging
  request** when the requested type no longer fits for those nights or the type has
  a rate but the registration carries no lodging line. Staff confirm the lodging and
  add any charge in Payments.
- The interactive site map (#779); staff editing of the property templates
  themselves (templates are code data).
- From slice 3 (#200): club and group registrations have rosters placed outside this
  screen (use an expected guest for a club that has no individual attendees yet); a
  minor linked to a responsible adult is kept with them as a *warning*, and the
  Man Camp "top bunk above the guardian's bottom bunk" rule (`top_guardian_child`,
  which does not reduce public capacity) is not modelled; registrant "Full" at
  selection still counts requests, not assignments; the lodging emails are written to
  the outbox and delivered like every other message but are not editable templates
  and do not appear in the Communications delivery log (the workspace shows each room
  notice's status); the waitlist and the event's registration waitlist are separate.
- The protected-records projection of an accommodation action (#192, ADR 0005
  still Proposed): the two flags are the only accommodation data held.
