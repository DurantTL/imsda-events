/**
 * Read-only report (#813): for every church-sponsored registration-level code redemption, the church's lodging share as stored
 * against what the recompute would give today. Run it before deploying #813 so the finance office can see what will move the
 * next time a registration edited under the #806 interim warning is touched by a staff lodging edit or an amendment.
 *
 * Prints registration ids, event ids, the promo code id, the church id and amounts (cents) only. It never writes: the whole
 * run is one READ ONLY transaction, so the database refuses a write.
 *
 *   npm run report:church-share-drift
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { reportChurchShareDrift } from "@/modules/lodging/church-share-drift";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

async function main() {
  const { scanned, rows } = await reportChurchShareDrift(prisma);
  console.log(`Church-sponsored redemptions scanned: ${scanned}`);
  if (rows.length === 0) {
    console.log("No registration's stored church share differs from the recompute. Nothing will move.");
    return;
  }
  console.log("registrationId\teventId\tpromoCodeId\tchurchId\tstoredCents\trecomputedCents\tdifferenceCents");
  for (const row of rows) {
    console.log([row.registrationId, row.eventId, row.promoCodeId, row.churchId, row.storedCents, row.recomputedCents, row.differenceCents].join("\t"));
  }
  const total = rows.reduce((sum, row) => sum + row.differenceCents, 0);
  console.log(`${rows.length} registration(s) would move; the net change to what churches owe is ${total} cents. Nothing was written.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
