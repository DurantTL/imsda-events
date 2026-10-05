/**
 * Operator step after migrations (#198): brings every lodging property
 * template (Camp Heritage, Sunnydale Academy) up to the version in the code.
 * Safe to run any number of times: a template is applied only when its version
 * is newer than the stored one, units a newer version drops are retired rather
 * than deleted, and per-event state (overrides, holds, rates) is never touched.
 * `docker-entrypoint.sh` runs it after `prisma migrate deploy`.
 *
 *   npm run lodging:sync
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const { getPrisma } = await import("../lib/prisma");
  const { syncLodgingTemplates } = await import("../modules/lodging/sync");
  const prisma = getPrisma();
  try {
    const { applied, unchanged } = await syncLodgingTemplates(prisma);
    for (const item of applied) console.log(`${item.key}: applied version ${item.version} (${item.units} units)`);
    for (const item of unchanged) console.log(`${item.key}: version ${item.version} already current`);
    console.log("Lodging templates are in sync.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
