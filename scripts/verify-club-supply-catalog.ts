/**
 * Proves the club supply catalog import (#531) against a real PostgreSQL
 * database: the whole committed reference file imports with no row dropped,
 * repeated catalog numbers are kept, honor rows link to matching honors, a
 * re-import changes nothing, a stale preview is refused, and club stock is one
 * row per club and item. Uses fictitious honors, a fictitious club and staff
 * user it creates and removes itself.
 *
 * It only runs against a database with an empty club supply catalog, so it
 * never touches a catalog someone imported, and it removes every item it
 * added when it finishes.
 *
 *   npm run test:club-supplies
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { parseClubSupplyCsv } from "../modules/club-supplies/catalog-csv";
import {
  applyClubSupplyImport,
  ClubSupplyError,
  listClubStock,
  previewClubSupplyImport,
  setClubStockQuantity,
  setClubSupplyItemActive,
} from "../modules/club-supplies/repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "csupply";
const userId = `${P}_admin`;
const clubId = `${P}_club`;
const honorIds = { bogs: `${P}_honor_bogs`, bogsAdvanced: `${P}_honor_bogs_adv`, welding: `${P}_honor_welding` };
const startedAt = new Date();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function cleanup() {
  const stock = await prisma.clubSupplyStock.findMany({ where: { organizationId: clubId }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { entityType: "ClubSupplyStock", entityId: { in: stock.map((row) => row.id) } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: userId } });
  await prisma.clubSupplyStock.deleteMany({ where: { organizationId: clubId } });
  await prisma.organization.deleteMany({ where: { id: clubId } });
  await prisma.honor.deleteMany({ where: { id: { in: Object.values(honorIds) } } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function main() {
  const existingItems = await prisma.clubSupplyItem.count();
  if (existingItems > 0) {
    throw new Error(`This check needs an empty club supply catalog; this database already has ${existingItems} items.`);
  }
  // Other honors keep their catalog fields: note them now, put them back after.
  const honorsBefore = await prisma.honor.findMany({ select: { id: true, catalogNumber: true, category: true } });
  await cleanup();
  try {
    await run();
  } finally {
    await prisma.clubSupplyStock.deleteMany({ where: { organizationId: clubId } });
    await prisma.clubSupplyItem.deleteMany({ where: { createdAt: { gte: startedAt } } });
    for (const honor of honorsBefore) {
      await prisma.honor.updateMany({ where: { id: honor.id }, data: { catalogNumber: honor.catalogNumber, category: honor.category } });
    }
    await cleanup();
  }
}

async function run() {
  await prisma.user.create({ data: { id: userId, email: `${P}-admin@example.test`, displayName: "Catalog Check Admin", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.create({ data: { id: clubId, type: "CLUB", name: "Catalog Check Club", normalizedName: "catalog check club" } });
  // Codes sort first so these win any tie with a same-named honor already in the database.
  await prisma.honor.createMany({
    data: [
      { id: honorIds.bogs, code: "0CSUPPLY-1", name: "Bogs and Fens", normalizedName: "bogs and fens" },
      { id: honorIds.bogsAdvanced, code: "0CSUPPLY-2", name: "Bogs & Fens, Advanced", normalizedName: "bogs & fens, advanced" },
      { id: honorIds.welding, code: "0CSUPPLY-3", name: "Welding (GC)", normalizedName: "welding (gc)" },
    ],
  });

  const file = readFileSync(path.join(process.cwd(), "docs/reference/adventsource-club-catalog.csv"), "utf8");
  const rows = parseClubSupplyCsv(file);
  assert(rows.length === 850, `expected 850 rows, parsed ${rows.length}`);
  const distinct = new Set(rows.map((row) => `${row.section}|${row.normalizedName}`));

  // 1. The full file imports with no row dropped.
  const preview = await previewClubSupplyImport(rows);
  const { summary } = preview.plan;
  assert(summary.problems === 0, `expected no problem rows, found ${summary.problems}`);
  assert(summary.added === distinct.size && summary.added + summary.duplicates === 850, `added ${summary.added}, merged ${summary.duplicates}`);
  const applied = await applyClubSupplyImport(rows, preview.fingerprint, userId);
  assert(applied.summary.added === distinct.size, "the saved plan should match the preview");
  const items = await prisma.clubSupplyItem.findMany();
  assert(items.length === distinct.size, `expected ${distinct.size} items, found ${items.length}`);
  const byKey = new Map(items.map((item) => [`${item.section}|${item.normalizedName}`, item]));
  const missing = rows.filter((row) => !byKey.has(`${row.section}|${row.normalizedName}`));
  assert(missing.length === 0, `rows with no item: ${missing.map((row) => row.line).join(", ")}`);
  console.log(`ok  full reference file imported: ${items.length} items from 850 rows, 0 dropped (${summary.duplicates} repeats merged)`);

  // 2. Repeated catalog numbers are kept, leading zeros intact.
  const withNumber = (number: string) => items.filter((item) => item.catalogNumber === number).length;
  assert(withNumber("002305") === 6, `expected 6 items on 002305, found ${withNumber("002305")}`);
  assert(withNumber("008585") === 2, `expected 2 items on 008585, found ${withNumber("008585")}`);
  assert(withNumber("007400") === 121, `expected 121 items on 007400, found ${withNumber("007400")}`);
  assert(items.find((item) => item.name === "Friend Pin")?.catalogNumber === "002120", "Friend Pin should keep 002120");
  assert(summary.repeatedNumbers > 0, "repeated numbers should be warned about");
  console.log("ok  repeated catalog numbers kept (002305 ×6, 008585 ×2, 007400 ×121) with leading zeros");

  // 3. Honor rows link to matching honors and set their number and category.
  const bogs = byKey.get("NATURE|bogs and fens");
  const bogsAdvanced = byKey.get("NATURE|bogs and fens, advanced");
  const welding = byKey.get("VOCATIONAL|welding");
  assert(bogs?.honorId === honorIds.bogs && bogsAdvanced?.honorId === honorIds.bogsAdvanced && welding?.honorId === honorIds.welding, "honor rows should link");
  const honors = await prisma.honor.findMany({ where: { id: { in: Object.values(honorIds) } } });
  const honor = (id: string) => honors.find((row) => row.id === id);
  assert(honor(honorIds.bogs)?.catalogNumber === "005157" && honor(honorIds.bogs)?.category === "NATURE", "Bogs and Fens should get 005157 / Nature");
  assert(honor(honorIds.bogsAdvanced)?.catalogNumber === "007400", "the Advanced honor should get 007400");
  assert(honor(honorIds.welding)?.catalogNumber === "006535" && honor(honorIds.welding)?.category === "VOCATIONAL", "Welding (GC) should get 006535 / Vocational");
  const unlinked = items.filter((item) => item.section === "NATURE" && !item.honorId).length;
  assert(unlinked > 0, "unmatched honor rows stay as unlinked items");
  const audit = await prisma.auditLog.findFirst({ where: { actorUserId: userId, action: "CLUB_SUPPLY_CATALOG_IMPORTED" } });
  const metadata = audit?.metadata as Record<string, number> | null;
  assert(metadata && metadata.honorsMatched >= 3 && metadata.honorsUnmatched === summary.honorsUnmatched, "audit should carry honor counts");
  console.log(`ok  honors linked (${summary.honorsMatched} matched, ${summary.honorsUnmatched} unmatched, audited as counts)`);

  // 4. A re-import of the same file changes nothing.
  const lastUpdated = Math.max(...items.map((item) => item.updatedAt.getTime()));
  const again = await previewClubSupplyImport(rows);
  assert(again.plan.summary.added === 0 && again.plan.summary.updated === 0, `re-import should change nothing, got ${JSON.stringify(again.plan.summary)}`);
  await applyClubSupplyImport(rows, again.fingerprint, userId);
  const after = await prisma.clubSupplyItem.findMany({ select: { updatedAt: true } });
  assert(after.length === items.length && Math.max(...after.map((item) => item.updatedAt.getTime())) === lastUpdated, "re-import should leave items untouched");
  console.log("ok  re-importing the same file is a no-op");

  // 5. A preview gone stale is refused, saving nothing.
  const stale = await previewClubSupplyImport(rows);
  await setClubSupplyItemActive(bogs!.id, false, userId);
  const refused = await applyClubSupplyImport(rows, stale.fingerprint, userId).then(() => null, (error: unknown) => error);
  assert(refused instanceof ClubSupplyError && refused.code === "PREVIEW_CHANGED", `expected PREVIEW_CHANGED, got ${String(refused)}`);
  assert((await prisma.clubSupplyItem.findUnique({ where: { id: bogs!.id } }))?.isActive === false, "the refused import must not reactivate the item");
  await setClubSupplyItemActive(bogs!.id, true, userId);
  console.log("ok  a stale preview is refused with PREVIEW_CHANGED and saves nothing");

  // 6. Club stock is one row per club and item.
  const actor = { userId, actAsId: `${P}_actas` };
  const first = await setClubStockQuantity(clubId, bogs!.id, 3, actor);
  const racing = await Promise.allSettled([
    setClubStockQuantity(clubId, welding!.id, 1, actor),
    setClubStockQuantity(clubId, welding!.id, 2, actor),
  ]);
  const unexpected = racing.filter((result) => result.status === "rejected"
    && !(result.reason instanceof ClubSupplyError && result.reason.code === "CATALOG_CONFLICT"));
  assert(unexpected.length === 0, "a racing first save may only fail with CATALOG_CONFLICT");
  const second = await setClubStockQuantity(clubId, bogs!.id, 5, actor);
  assert(first.id === second.id && second.quantityOnHand === 5, "a second save updates the same stock row");
  assert(await prisma.clubSupplyStock.count({ where: { organizationId: clubId, itemId: welding!.id } }) === 1, "one stock row per club and item");
  const stockAudit = await prisma.auditLog.findMany({ where: { entityType: "ClubSupplyStock", entityId: first.id } });
  assert(stockAudit.length === 2, `expected 2 stock audits on the stock row id, found ${stockAudit.length}`);
  const listed = await listClubStock(clubId);
  assert(listed.find((row) => row.itemId === bogs!.id)?.quantityOnHand === 5, "the club's list shows the saved quantity");
  console.log("ok  club stock: one row per club and item, audited against the stock row");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
