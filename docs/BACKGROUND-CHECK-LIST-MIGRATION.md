# Background-check list migration (#527)

Migration `20260928210000_background_check_list` replaces the old
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
(`npm run background-checks:migration-dry-run`). Running the migration
against production is a human step (AGENTS.md).

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
after the migration, after a refresh for each person, after a roster upload
with the same `user_id`s, and for a new adult registered afterward who is on
the list.
