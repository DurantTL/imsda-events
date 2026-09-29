/**
 * Operator step after migrations (#610): brings every club form template up
 * to the version in the code. A version that makes an answer newly sensitive
 * re-seals the existing submissions in the same transaction as the template
 * update, so this can take a while on a large table and must not run inside a
 * web request. Until it has run, saves to a behind template are refused with
 * "being updated" and readers already treat the code's sensitive keys as
 * restricted.
 *
 *   npm run club-forms:sync
 *
 * Safe to run any number of times. It refuses (and changes nothing for that
 * form) when a version would make a sensitive answer or a birth date readable
 * again; that needs a reviewed change.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const { getPrisma } = await import("../lib/prisma");
  const { syncClubFormTemplates } = await import("../modules/club-forms/templates");
  const prisma = getPrisma();
  try {
    await syncClubFormTemplates(prisma);
    const rows = await prisma.clubFormTemplate.findMany({ orderBy: { sortOrder: "asc" }, select: { key: true, version: true, enabled: true } });
    for (const row of rows) console.log(`${row.key}: version ${row.version}${row.enabled ? " (on)" : " (off)"}`);
    console.log("Club form templates are in sync.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
