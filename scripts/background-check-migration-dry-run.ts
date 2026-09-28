import { getPrisma } from "@/lib/prisma";

/**
 * Dry run for the #527 migration (`prisma/migrations/20260928210000_
 * background_check_list`): counts how many existing `BackgroundCheck` rows
 * would be carried over as migrated entries, and how many have no matching
 * `Person` row (which the migration's join would silently drop). Run this
 * before `prisma migrate deploy` against a real database; running the
 * migration itself against production is a human step (AGENTS.md).
 *
 * Also counts the remembered roster user_ids (`ExternalIdentity`,
 * `ROSTER_IMPORT`) the migration rewrites to `userId:<id>`. The migration
 * is roll-forward only: see docs/BACKGROUND-CHECK-LIST-MIGRATION.md.
 *
 * Reads only counts — never names, dates, or other row contents.
 */
async function main() {
  const prisma = getPrisma();
  const [totalRows, rowsWithPerson, identitiesToRewrite, rowsWithRememberedId] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "BackgroundCheck"`,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "BackgroundCheck" bc
      JOIN "Person" p ON p."id" = bc."personId"
    `,
    // Remembered roster user_ids the migration rewrites to "userId:<id>".
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "ExternalIdentity"
      WHERE "provider" = 'ROSTER_IMPORT' AND "providerScope" = '' AND "externalId" NOT LIKE 'userId:%'
    `,
    // Of the migrated rows, how many are keyed by a remembered user_id (the rest by "migrated:<id>").
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "BackgroundCheck" bc
      JOIN "Person" p ON p."id" = bc."personId"
      JOIN "ExternalIdentity" ei ON ei."personId" = bc."personId" AND ei."provider" = 'ROSTER_IMPORT' AND ei."providerScope" = ''
    `,
  ]);
  const total = Number(totalRows[0]?.count ?? BigInt(0));
  const withPerson = Number(rowsWithPerson[0]?.count ?? BigInt(0));
  const orphaned = total - withPerson;
  process.stdout.write(`${JSON.stringify({
    totalBackgroundCheckRows: total,
    rowsThatWillMigrate: withPerson,
    rowsWithNoMatchingPerson: orphaned,
    rosterImportIdentitiesToRewrite: Number(identitiesToRewrite[0]?.count ?? BigInt(0)),
    migratedRowsKeyedByUserId: Number(rowsWithRememberedId[0]?.count ?? BigInt(0)),
  }, null, 2)}\n`);
  if (orphaned > 0) {
    process.stderr.write(`Warning: ${orphaned} row(s) have no matching Person and will be dropped by the migration's join.\n`);
    process.exitCode = 2;
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
