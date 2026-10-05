# Lodging inventory and availability (#198, slice 1)

Reusable lodging inventory for on-site properties, with per-event state and
night-by-night availability computed on the server. It holds **facility data
only**: no person, preference, assignment or waitlist (those are #199 and
#200), and no occupant names from the source sheets.

Code lives in `modules/lodging/`; the staff screen is **More > Lodging**
(`/more/lodging`).

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
`occupied` is zero in this slice and is the input #200 supplies. `stayFit`
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
  amount x nights x units; per person: amount x nights x people. **Charging at
  registration is out of scope here** and comes with #199 and #200.

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
picks a property again. `npm run test:event-cloning` checks that a clone of an
event that uses a property carries none of it.

## Checks

- Unit tests: `tests/lodging-domain.test.ts`, `tests/lodging-templates.test.ts`,
  `tests/lodging-routes.test.ts`.
- Real database: `npm run test:lodging` (`scripts/verify-lodging-inventory.ts`,
  local database only, wired into CI). It covers template sync idempotency and
  parallel runs, versioned retirement, event property choice, default holds,
  night-by-night availability with partial stays and closures, overrides, hold
  history, racing holds, the direct-delete refusals, hotel details, rates, audit
  rows, and cascade on event deletion.

## Not in this slice

Preferences and roommate requests, assignments, waitlists, charging, the attendee
display and rooming reports (#199, #200); the interactive site map (#779);
staff editing of the property templates themselves (templates are code data).
