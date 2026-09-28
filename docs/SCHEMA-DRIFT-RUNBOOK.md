# Schema drift cleanup runbook (#513)

`prisma/schema.prisma`'s index definitions had drifted from the committed
migration history (found while building #486, #490, #491). A fresh
`prisma migrate dev` against `main` generated `DROP INDEX`, `RENAME INDEX`,
and column-default statements unrelated to the change being made, on
`MerchandiseProduct`, `MerchandiseVariantAvailability`,
`PersonMatchCandidate`, and other tables. Every new migration had to be
trimmed by hand.

## Drift decisions

`npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script`
reported ten differences. Each is resolved below, choosing per-index the
direction that leaves current production behavior unchanged unless an index
is clearly obsolete.

| Table.index | Drift | Decision | Why |
| --- | --- | --- | --- |
| `MerchandiseProduct_eventId_isEnabled_idx` (`eventId, isEnabled`) | In migration history, not in schema | **Drop in a new migration** | Superseded by the wider `@@index([eventId, isEnabled, isArchived, position])` added later in `20260808130000_merchandise_catalog`, which shares the same leading columns and already serves any query this index served. Keeping both means every write pays to maintain a redundant index for no query-planning benefit. |
| `MerchandiseVariantAvailability_variantId_isActive_idx` (`variantId, isActive`) | In migration history, not in schema | **Drop in a new migration** | Same pattern: superseded by `@@index([variantId, isActive, salesStartsAt, salesEndsAt])`, added later in the same migration, which shares the `variantId, isActive` prefix. |
| `PersonMatchCandidate.matchedSignals` / `.contradictingSignals` defaults | `DEFAULT ARRAY[]::"PersonMatchSignal"[]` in migration history, no default in schema | **Add `@default([])` to `schema.prisma`** | Production already has this default (from `20260918090000_person_match_candidates`, the original migration). Dropping it would be a behavior change with no benefit; declaring it in the schema instead makes the schema match what is already deployed. |
| `EventAttendeeClassification_eventId_kind_isActive_sortOrder_lab` → `..._idx` | Stored index name differs from schema's default name | **Rename in a new migration** | Same columns (`eventId, kind, isActive, sortOrder, label`), same uniqueness. The name written in the original `CREATE INDEX` statement is 76 characters; Postgres silently truncates identifiers over 63 bytes, so the name actually stored (and what `migrate diff` sees) is already a truncated form. Prisma's own default-name truncation now computes a different truncated name for the same index. Purely cosmetic — `ALTER INDEX ... RENAME` is a metadata-only change. |
| `MerchandiseVariantAvailability_sales_window_idx` → `..._salesStar_idx` | Same | **Rename in a new migration** | The original migration used an explicit short `map:` name that a later schema edit removed, reverting to Prisma's auto-generated (truncated) name. Same columns (`variantId, isActive, salesStartsAt, salesEndsAt`). |
| `MessageOutbox_provider_providerDeliveryStatus_providerStatusAt_` → `..._idx` | Same | **Rename in a new migration** | Same 63-byte truncation mismatch as above; same columns. |
| `ProgramAssignmentRun_eventId_formVersionId_fieldId_invalidatedA` → `..._idx` | Same | **Rename in a new migration** | Same. |
| `RegistrationAccessToken_registrationId_purpose_revokedAt_expire` → `..._idx` | Same | **Rename in a new migration** | Same. |
| `RegistrationCapacityReservation_formId_fieldId_optionValue_rele` → `..._idx` | Same | **Rename in a new migration** | Same. |
| `RegistrationPaymentChoiceOperation_registrationId_clientRequest` → `..._key` | Same | **Rename in a new migration** | Same 63-byte truncation mismatch, on a unique constraint's backing index rather than a plain index. |

All ten differences are resolved by `prisma/migrations/20260928200000_schema_drift_index_cleanup/`
plus the two-line `@default([])` addition to `schema.prisma` for
`PersonMatchCandidate`. After both changes,
`prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code`
reports no difference (exit code 0), and a fresh `prisma migrate dev` against
the resulting history produces no unrelated statements.

## Lock file

`prisma/migrations/migration_lock.toml` is now tracked, containing:

```toml
provider = "postgresql"
```

Prisma recommends tracking it (it asserts the migration history was written
for one provider and blocks an accidental provider switch), and
`prisma migrate diff --from-migrations` refuses to run without it — which is
exactly the command this issue's CI check depends on. Two earlier PRs (#490,
#491) each added a commit dropping this file on the belief the repo
intentionally didn't track it; that undocumented convention is what left the
drift check unusable. Tracking it going forward avoids repeating that.

## CI check

`.github/workflows/ci.yml`'s `verify` job now creates a scratch
`imsda_events_shadow` database on the CI Postgres service (the same service
used for `db:deploy`/`db:seed`/tests) and runs:

```sh
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://imsda:imsda_ci@localhost:5432/imsda_events_shadow?schema=public \
  --exit-code
```

`--exit-code` makes the step (and therefore the job) fail with exit code 2
when the diff is non-empty. This runs right after `npm run db:deploy` and
before seeding/tests, so drift is caught before the rest of the job spends
time on a build that will need a schema or migration fix regardless.

Verified locally (not committed): pointing `prisma migrate diff` at a
deliberately narrowed `MerchandiseProduct` index (dropping `position` from
the `@@index`, no matching migration) reproduces the CI failure — the diff
prints the change and the command exits 2. The unmodified branch exits 0 with
"No difference detected."

## Production migration (human-only)

Applying `20260928200000_schema_drift_index_cleanup` to the production
database is a production migration and stays a human-only step per
[`AGENTS.md`](../AGENTS.md). This issue only prepares and documents it; a
human runs `prisma migrate deploy` against production (the same command CI
already runs against its scratch database) after review. The migration is
metadata-only — two `DROP INDEX` statements on indexes shown above to be
redundant, and seven `ALTER INDEX ... RENAME` statements — so it takes no
table lock beyond the brief catalog updates those statements require, and it
changes no application-visible data.
