# Merchandise ledger migration guidance

The `20260808120000_merchandise_ledger` migration is additive. It creates the
event-owned catalog and order ledger without seeding catalog data, changing a
registration total, or rewriting an existing payment or refund.

## Rollout

Apply the migration before deploying code that writes merchandise records.
Afterward, validate the partial unique index for active availability rows and
the amount and inventory check constraints. Catalog setup and any future
checkout remain separate, reviewable work.

## Rollback

Roll back application code first so no process writes these tables. If the
tables are still empty, a reviewed corrective migration may drop them in
foreign-key order and then drop the four merchandise enums.

Do not drop the merchandise tables after any order exists. Order lines are the
commercial record and must survive catalog edits, disablement, and deletion.
Keep the additive schema in place while the application is rolled back.

## Forward fix

If a deployed constraint or relation needs correction after orders exist,
create a new additive migration. Preserve every order line snapshot and request
fingerprint; add replacement columns or constraints, backfill them from the
ledger in a transaction, validate them, and only retire obsolete fields in a
later human-reviewed migration.

Never repair catalog history by updating purchased snapshots, folding a
merchandise amount into `Registration.totalAmount`, or converting cash/check
references into card-provider records. Production migration execution and any
production data repair remain human gates.
