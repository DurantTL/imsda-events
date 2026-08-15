# Attendee type reference contract

Issue #133 establishes the shared attendee-type contract for session restrictions
(#100), promo restrictions (#102), occupancy rules (#64), and future pricing.

## Consumer contract

Consumers must use `getAttendeeTypeReference(eventId, attendeeId)` from
`modules/attendee-types/repository.ts`, or `attendeeTypeReference(attendee)` when
the attendee and relation are already loaded. The result is:

```ts
type AttendeeTypeReference = {
  id: string | null;
  code: string | null;
  labelSnapshot: string;
  ageBand: { minimumAge: number | null; maximumAge: number | null } | null;
};
```

- Use `id` for foreign keys and same-database restrictions. Use immutable `code`
  only for durable configuration/import interchange. Never match `labelSnapshot`.
- `labelSnapshot` is the label recorded when registration occurred. Renaming or
  deactivating a definition does not change it.
- A null identity/age band means a legacy value has not been mapped. Consumers
  must report or reject it according to their workflow; they must not guess.
- `ageOnEventDate` and `isWithinAgeBand` evaluate a birth date at the event date.
  They do not use the registration date or today's date.
- Categories, tracks, and departments use `EventAttendeeClassification` and the
  many-to-many `RegistrationAttendeeClassification` join. They are not attendee
  types and must not be inferred from one.

## Forms and history

A single-choice attendee-scoped field may set
`optionSource: "ATTENDEE_TYPES"`. Its active options are hydrated from event
configuration for builder preview, public rendering, and server validation. The
submitted code resolves to the event-owned identity; the current display label
is copied to `RegistrationAttendee.attendeeType`. Deactivated definitions remain
linked to existing attendees but disappear from future form choices.

## Legacy backfill

Run a dry-run (the default) with:

```sh
npm run attendee-types:backfill -- --event-id <event-id>
```

After reviewing every distinct value, add `--apply`. Only an exact,
case-insensitive, trimmed match to one configured code or label is mapped.
Missing and ambiguous matches are reported and left null. Re-running is safe:
only rows whose identity is still null are considered.
