# Program assignments

This module turns attendee-level `RANKED_CHOICE` answers marked
`RANKED_INTEREST` into reviewed seminar or room rosters.

## Staff workflow

Staff need both `MANAGE_REGISTRATION` and `VIEW_SENSITIVE_DATA` to open
**More → Seminar assignments**:

1. Choose an exact published registration-form version and ranked field.
2. Build a read-only preview.
3. Review room limits, first/second/lower-choice totals, and unassigned people.
4. Explicitly apply the reviewed fingerprint.

Preview never writes data. Apply creates an immutable
`ProgramAssignmentRun` plus one normalized `ProgramAttendeeAssignment` row per
attendee. A later apply creates another run linked through `supersedesRunId`;
it does not update or delete the earlier run. Every applied run has a
permission-scoped print view and formula-safe CSV export.

## Deterministic assignment

The pure domain algorithm uses minimum-cost maximum flow with a lexicographic
tuple cost. In order, it:

1. maximizes the number of assigned attendees;
2. maximizes first-choice assignments over second/lower choices;
3. minimizes the remaining preference-rank distance;
4. uses submitted time, registration ID, attendee position/ID, and published
   option order as deterministic tie-breakers.

The worst-case implementation cost is `O(F × V × E)`, where `F` is the number
of assigned attendees and the flow graph contains attendee, preference, and
room edges. Typical IMSDA ranked fields have only two preferences per attendee,
so the graph remains sparse.

Every configured `choiceLimits` number is an assignment-room capacity. A
missing limit is reported explicitly and treated as unlimited; it is never
silently treated as zero. Public interest collection may exceed these limits.

## Exact-source safety

The SHA-256 preview fingerprint includes:

- event, form, published version, field, choices, and limits;
- only active `SUBMITTED` and `CONFIRMED` registrations from that exact form
  version;
- immutable attendee response and identity snapshots needed for assignment;
- stable submission and attendee ordering.

Apply reloads and recomputes this source inside a PostgreSQL `Serializable`
transaction. A changed source or limit returns `409 SOURCE_CHANGED`. A strict
client UUID makes apply idempotent, including unique-index races.

Applied rows snapshot only attendee identity, registration reference, the
selected ranked-choice value, and the assignment result. Medical, allergy,
accessibility, special-needs, and other free text is never copied into a
preview, applied run, audit entry, print view, or export.

## Intentional boundaries

- Only attendee-level ranked-interest fields are assignable. Registration-level
  ranked fields appear as an unsupported diagnostic rather than being guessed
  onto an attendee.
- Versions are kept separate; answers from versions with different immutable
  definitions are not merged.
- Apply does not alter registration responses, public capacity reservations,
  registration status, payments, or message outbox rows.
- No email is sent. Staff decide separately how or when assignments are shared.

Schema support is introduced by
`prisma/migrations/20260723110000_program_assignments`.
