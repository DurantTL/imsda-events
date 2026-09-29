# Background-check list migration (#527)

Migration `20260928240000_background_check_list` replaces the old
one-row-per-person `BackgroundCheck` table with the stored list
(`BackgroundCheckUpload`, `BackgroundCheckEntry`, `BackgroundCheckMatch`,
`BackgroundCheckReview`). It runs automatically with `prisma migrate deploy`,
so everything it does has to be safe without a manual step:

- Every existing `BackgroundCheck` row becomes a list entry with a `MIGRATED`
  match to the same person, so nobody's status changes on the day it ships.
  A refresh never deletes a `MIGRATED` (or `MANUAL`) match; the next real
  upload replaces the list and re-matches everyone from the new file.
- Remembered roster `user_id`s (`ExternalIdentity`, provider `ROSTER_IMPORT`)
  are rewritten from the raw id to `userId:<id>`, the one format the list
  uses, and migrated entries are keyed the same way. The first roster upload
  after deploy therefore counts those people as "changed", not dropped and
  re-added, and matches them by their remembered id.
- Names are never normalized in SQL. Migrated entries get
  `normalizedName = NULL`; the first refresh or upload fills it in with the
  TypeScript `matchableName`, so accented and hyphenated names normalize the
  same way everywhere.

Before deploying against production, a human runs the count-only dry run
(`npm run background-checks:migration-dry-run`). It reports how many rows
migrate, how many have no matching person, how many remembered roster
`user_id`s the migration rewrites, and how many migrated rows are keyed by
one. Running the migration against production is a human step (AGENTS.md).

**The migration is roll-forward only.** There is no down migration: it
rewrites `ExternalIdentity.externalId` in place and renames the old table.
If the new list has to be backed out, fix forward with a new migration (the
old rows are still in `BackgroundCheck_pre527` for one release); do not
restore the previous application image against the migrated database, since
it expects the old table name and raw `user_id`s.

## What staff see on the first uploads after deploy

- **A roster file** recognizes migrated entries by their remembered
  `user_id`: those people count as "changed".
- **A Sterling file** can't recognize migrated entries — the old table never
  kept an email or birth date, so they're keyed `migrated:<id>`. The first
  Sterling upload therefore shows every migrated entry as dropped and the
  file's rows as added. That is expected, and the upload preview says so;
  people are matched from the new file as usual once it's saved.
- A non-clear Sterling status is reported as a row problem ("not a clear
  check, nothing was recorded") and never stored, exactly as before #527.

## Staff review decisions

- **Match** makes a `MANUAL` match: a staff decision that holds across
  refreshes and uploads (carried to the next upload's entry with the same
  identity key, even if the name changed) until staff use "Undo match".
- **None of these** (a dismissal) holds until the next upload replaces the
  list. Until then that entry is matched to no one — not by a refresh, not at
  read time — and it shows under "Not matched yet". Anyone the dismissed
  review named is held too: if two rows matched one person and staff dismiss
  one, the other row's review stays open and that person isn't auto-matched
  to it until staff decide. The next upload starts every entry fresh.
- A decision made while an upload is in progress, or one that collides with
  a concurrent change, is refused with a 409 and can simply be retried.

## Indexes Prisma can't model

The migration adds `Person_matchable_compact_idx`, an expression index on the
compacted name the name-group lookup filters by
(`PERSON_COMPACT_NAME_SQL` in `modules/background-checks/repository.ts`,
which must match the index expression exactly). Prisma's schema can't
express an expression index, and `prisma migrate diff` ignores indexes it
can't represent, so the drift check still exits 0; `npm run
test:background-check-list` asserts the lookup's expression is the index's
and that the query plan is an index scan.

## Follow-up: drop `BackgroundCheck_pre527`

The migration does not drop the old table. It renames it to
`BackgroundCheck_pre527`, which nothing reads or writes (the Prisma model
`BackgroundCheckPre527` is `@@ignore`d, so Prisma Client has no accessor
for it), and keeps it for one release as a fallback while the new list is
verified in production.

After that release, a later migration drops it:

```sql
DROP TABLE "BackgroundCheck_pre527";
```

together with removing the `BackgroundCheckPre527` model and the
`Person.backgroundChecksPre527` back-relation from `prisma/schema.prisma`,
so the drift check (`docs/SCHEMA-DRIFT-RUNBOOK.md`) stays clean. Like any
production migration, a human approves and runs that deploy.

## Verification

`npm run test:background-check-list` (also run in CI) builds a scratch
PostgreSQL database, applies the migrations up to `20260928200000`, inserts
synthetic `Person`, `BackgroundCheck`, and `ExternalIdentity` rows (including
accented and hyphenated names and a couple sharing one email), then applies
this migration and checks that everyone's compliance state is unchanged:
after the migration, after a refresh for each person, and after a roster
upload with the same `user_id`s. It then checks that a new adult registered
afterward who is on the list is checked at read time and from the cache a
write path fills; that a save during an upload isn't held up (the refresh
only try-locks and is skipped); and that an entry two people in different
clubs could be is matched to neither, at read time or after staff dismiss
its review.

## Name-only matches and the lookup (#598)

The roster export has no email or birth date, so the row's site used to be the only second check. Now:

- A row whose name is the only one on the list, and the only person on file with that name (a roster or registration adult, and no other person at all), is matched even when its site differs. It is stored as `NAME_ONLY` (an additive enum value; `20260929100000_background_check_name_only_match`), listed under "Matched by name only" for a spot check, and never remembered as a `user_id`. An email or birth date that disagrees stops it. "Not the same person" removes the match and keeps a dismissed review on the row, so a Refresh never re-matches it (the next upload replaces the list).
- Several same-name candidates with nothing to separate them, or several rows for one candidate, go to review.
- With no exact-name candidate, a same-last-name candidate whose first name is a prefix of, contains, or is contained in the row's (3 characters or more) goes to review, never to a match. Variants are looked for by the staff Refresh and the upload, not by the per-person refresh.
- Roster members count as candidates when their type is ADULT or STAFF, or their sealed birth date makes them 18 or older today.
- The staff **Refresh** button re-runs matching for the whole list under the current rules (no new upload, no migration to run by hand); staff decisions are kept. The **Why isn't this person matched?** lookup is read-only and shows no birth dates.
