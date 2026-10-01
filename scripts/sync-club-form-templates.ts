/**
 * Operator step after migrations (#610): brings every club form template up
 * to the version in the code. A version that makes an answer newly sensitive
 * re-seals the existing submissions in the same transaction as the template
 * update, so this can take a while on a large table and must not run inside a
 * web request. `docker-entrypoint.sh` runs it after `prisma migrate deploy`
 * and before the app starts; until it has run, saves to a behind template are
 * refused and readers already treat the code's sensitive keys as restricted.
 *
 *   npm run club-forms:sync
 *
 * Safe to run any number of times. It carries on past a form it refuses (a
 * version that would make a sensitive answer or a birth date readable again
 * needs a reviewed change, and changes nothing for that form), syncs every
 * other form, reports each refusal, and exits non-zero at the end.
 *
 * A template that was edited or created in the club form builder (#712) is
 * never overwritten: the sync logs that it skipped it.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const { getPrisma } = await import("../lib/prisma");
  const { syncClubFormTemplates } = await import("../modules/club-forms/templates");
  const prisma = getPrisma();
  try {
    const { refused, skipped } = await syncClubFormTemplates(prisma, { continueOnRefusal: true });
    for (const item of skipped) console.log(`SKIPPED ${item.key}: ${item.reason}; the code's version is not applied.`);
    const rows = await prisma.clubFormTemplate.findMany({ orderBy: { sortOrder: "asc" }, select: { key: true, version: true, enabled: true } });
    for (const row of rows) console.log(`${row.key}: version ${row.version}${row.enabled ? " (on)" : " (off)"}`);
    if (refused.length > 0) {
      for (const item of refused) console.error(`REFUSED ${item.message}`);
      console.error(`${refused.length} club form template(s) were not synced and need a reviewed change.`);
      process.exitCode = 1;
      return;
    }
    console.log("Club form templates are in sync.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
