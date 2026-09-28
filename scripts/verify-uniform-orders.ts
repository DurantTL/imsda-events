/**
 * Proves uniform ordering (#497) against a real PostgreSQL database, on top
 * of the club order layer (#487): bulk needs by member, item and size (each
 * size its own catalog item) are recorded under the club's lock and never
 * doubled; the order math (needed + extras - available stock, never below
 * zero) matches what is ordered, exported, and received; ordered needs never
 * appear on the next order; receiving adds the ordered quantity to stock;
 * issuing takes the item out of stock (from a received unit or straight from
 * stock, never below zero); "already has one" marks a need issued without
 * touching stock; honors and uniforms share one order batch and one
 * AdventSource file; a double "Place order" and a double bulk entry each
 * happen once; the pick list carries names, items and sizes only; hand
 * edits are audited with counts and ids only; and a view-only load writes
 * nothing. Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:uniform-orders
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { clubYearFor } from "../modules/club-rosters/domain";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "uord";
const staffUserId = `${P}_staff`;
const clubs = {
  main: `${P}_club`,
  race: `${P}_club_race`,
  combo: `${P}_club_combo`,
  stock: `${P}_club_stock`,
  view: `${P}_club_view`,
  other: `${P}_club_other`,
  mark: `${P}_club_mark`,
  depart: `${P}_club_depart`,
  moved: `${P}_club_moved`,
};
const items = {
  scarf: `${P}_item_scarf`,
  slide: `${P}_item_slide`,
  shirtM: `${P}_item_shirt_m`,
  shirtL: `${P}_item_shirt_l`,
  inactive: `${P}_item_inactive`,
  honorPatch: `${P}_item_honor_patch`,
  camporee: `${P}_item_camporee`,
};
const honorId = `${P}_honor`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(error && typeof error === "object" && "code" in error && (error as { code: string }).code === code, `${message}: expected ${code}, got ${String(error)}`);
}

const startsWithP = { startsWith: `${P}_` };

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: staffUserId }, { metadata: { path: ["organizationId"], string_starts_with: `${P}_` } }] } });
  await prisma.clubOrderNeed.deleteMany({ where: { organizationId: startsWithP } });
  const batches = await prisma.clubSupplyOrderBatch.findMany({ where: { organizationId: startsWithP }, select: { id: true } });
  await prisma.clubSupplyOrderLine.deleteMany({ where: { batchId: { in: batches.map((row) => row.id) } } });
  await prisma.clubSupplyOrderBatch.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.clubSupplyStock.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.clubSupplyItem.deleteMany({ where: { id: startsWithP } });
  await prisma.memberHonorEntry.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.honor.deleteMany({ where: { id: startsWithP } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.person.deleteMany({ where: { id: startsWithP } });
  await prisma.organization.deleteMany({ where: { id: startsWithP } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

const thisClubYear = clubYearFor(new Date());
let personCounter = 0;

async function addMember(organizationId: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE", clubYear = thisClubYear) {
  personCounter += 1;
  const id = `${P}_person_${personCounter}`;
  await prisma.person.create({ data: { id, firstName: `Member${personCounter}`, lastName: "Sample" } });
  await prisma.clubRosterMember.create({
    data: { id: `${id}_roster`, organizationId, clubYear, personId: id, attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", status, source: "DIRECTOR" },
  });
  return id;
}

async function addMembers(organizationId: string, count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) ids.push(await addMember(organizationId));
  return ids;
}

async function stockOf(organizationId: string, itemId: string) {
  const row = await prisma.clubSupplyStock.findUnique({ where: { organizationId_itemId: { organizationId, itemId } }, select: { quantityOnHand: true } });
  return row?.quantityOnHand ?? 0;
}

const countNeeds = (organizationId: string, where: Record<string, unknown> = {}) =>
  prisma.clubOrderNeed.count({ where: { organizationId, ...where } });

async function main() {
  const { recordUniformNeeds, removeUniformNeeds, loadUniformWorkspace } = await import("../modules/uniforms/order-source");
  const { syncHonorOrderNeeds } = await import("../modules/honors/order-source");
  const {
    createOrderBatch, getOrderBatch, listAwardableNeeds, listOrderList, listPickList,
    loadOrderWorkspace, markNeedsAlreadyAwarded, markNeedsAwarded, markOrderBatchReceived,
  } = await import("../modules/club-orders/repository");
  const { adventSourceOrderCsv, readableOrderCsv, applyExtras } = await import("../modules/club-orders/domain");
  const { parseCsvMatrix } = await import("../modules/imports/csv-parser");

  await cleanup();
  const actor = { userId: staffUserId, actAsId: `${P}_actas` };
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Uniform Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.createMany({
    data: Object.entries(clubs).map(([key, id]) => ({ id, type: "CLUB" as const, name: `Uniform Check ${key} Club`, normalizedName: `uniform check ${key} club` })),
  });
  await prisma.honor.create({ data: { id: honorId, code: `${P.toUpperCase()}-1`, name: "Camping Skills", normalizedName: "camping skills" } });
  await prisma.clubSupplyItem.createMany({
    data: [
      { id: items.scarf, section: "CLASS_A_UNIFORM_ACCESSORIES", name: "Adult Scarf", normalizedName: `${P} adult scarf`, catalogNumber: "020001" },
      { id: items.slide, section: "CLASS_A_UNIFORM_ACCESSORIES", name: "Adult Slide", normalizedName: `${P} adult slide`, catalogNumber: "020045" },
      { id: items.shirtM, section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (M)", normalizedName: `${P} boys short sleeve shirt m`, catalogNumber: "011112", sizeLabel: "M" },
      { id: items.shirtL, section: "CLASS_A_DRESS_APPAREL", name: "Boys' Short Sleeve Shirt (L)", normalizedName: `${P} boys short sleeve shirt l`, catalogNumber: "011113", sizeLabel: "L" },
      { id: items.inactive, section: "OTHER_APPAREL", name: "Retired Sweatshirt (M)", normalizedName: `${P} retired sweatshirt m`, catalogNumber: "030001", isActive: false },
      { id: items.honorPatch, section: "OUTDOOR_INDUSTRIES", name: "Camping Skills", normalizedName: `${P} camping skills`, catalogNumber: "005157", honorId },
      { id: items.camporee, section: "CAMPOREES", name: "Camporee Patch", normalizedName: `${P} camporee patch`, catalogNumber: "090001" },
    ],
  });

  // ---------------------------------------------------------------- 1. bulk needs
  const twelve = await addMembers(clubs.main, 12);
  const bulk = await recordUniformNeeds(clubs.main, { personIds: twelve, itemIds: [items.scarf, items.slide], alreadyHasOne: false }, actor);
  assert(bulk.created === 24 && bulk.skipped === 0, `12 members x scarf and slide should record 24 needs, got ${JSON.stringify(bulk)}`);
  const recorded = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.main }, select: { sourceType: true, sourceId: true, status: true, sourceLabel: true } });
  assert(recorded.every((need) => need.sourceType === "UNIFORM" && need.status === "NEEDED"), "every recorded need is a NEEDED UNIFORM need");
  assert(new Set(recorded.map((need) => need.sourceId)).size === 24, "every need has its own key");
  const recordAudits = await prisma.auditLog.findMany({ where: { action: "CLUB_UNIFORM_NEEDS_RECORDED", metadata: { path: ["organizationId"], equals: clubs.main } }, select: { metadata: true, summary: true, actorUserId: true } });
  assert(recordAudits.length === 1, "one audit row for the bulk entry");
  const audit = recordAudits[0].metadata as Record<string, unknown>;
  assert(audit.needCount === 24 && audit.memberCount === 12 && audit.skippedCount === 0 && JSON.stringify(audit.itemIds) === JSON.stringify([items.scarf, items.slide]), `audit carries counts and item ids, got ${JSON.stringify(audit)}`);
  assert(recordAudits[0].actorUserId === staffUserId, "the audit row names the acting staff user");
  assert(!/Member\d|Sample/.test(JSON.stringify(recordAudits)), "the audit row holds no member name");
  console.log("ok  bulk entry: 12 members x scarf and slide = 24 needs, one audit row with counts and item ids only");

  // Re-submitting never doubles anything.
  const again = await recordUniformNeeds(clubs.main, { personIds: twelve, itemIds: [items.scarf, items.slide], alreadyHasOne: false }, actor);
  assert(again.created === 0 && again.skipped === 24 && await countNeeds(clubs.main) === 24, `re-submitting creates nothing, got ${JSON.stringify(again)}`);
  assert(await prisma.auditLog.count({ where: { action: "CLUB_UNIFORM_NEEDS_RECORDED", metadata: { path: ["organizationId"], equals: clubs.main } } }) === 1, "a no-op entry writes no audit row");
  console.log("ok  re-submitting the same entry is a no-op (24 skipped), no second audit row");

  // ---------------------------------------------------------------- 2. refusals are atomic
  const outsider = await addMember(clubs.other);
  const lastYearMember = await addMember(clubs.main, "ACTIVE", "2000-01");
  const inactiveMember = await addMember(clubs.main, "INACTIVE");
  const before = await countNeeds(clubs.main);
  for (const [label, input, code] of [
    ["a honor patch", { personIds: [twelve[0]], itemIds: [items.honorPatch] }, "ITEM_NOT_ORDERABLE"],
    ["a camporee patch", { personIds: [twelve[0]], itemIds: [items.camporee] }, "ITEM_NOT_ORDERABLE"],
    ["an inactive item", { personIds: [twelve[0]], itemIds: [items.inactive] }, "ITEM_NOT_ORDERABLE"],
    ["a missing item", { personIds: [twelve[0]], itemIds: [`${P}_nope`] }, "ITEM_NOT_ORDERABLE"],
    ["another club's member", { personIds: [twelve[0], outsider], itemIds: [items.shirtM] }, "MEMBER_NOT_ON_ROSTER"],
    ["last year's roster member", { personIds: [lastYearMember], itemIds: [items.shirtM] }, "MEMBER_NOT_ON_ROSTER"],
    ["an inactive member", { personIds: [inactiveMember], itemIds: [items.shirtM] }, "MEMBER_NOT_ON_ROSTER"],
  ] as const) {
    await expectCode(recordUniformNeeds(clubs.main, { ...input, alreadyHasOne: false }, actor), code, label);
  }
  assert(await countNeeds(clubs.main) === before, "a refused entry records nothing at all");
  console.log("ok  refused: non-uniform, inactive, or missing items and members not on this year's roster, with nothing recorded");

  // ---------------------------------------------------------------- 3. order math with stock and extras
  await prisma.clubSupplyStock.create({ data: { organizationId: clubs.main, itemId: items.scarf, quantityOnHand: 5 } });
  const list = await listOrderList(clubs.main, new Map([[items.scarf, 3]]));
  const scarfLine = list.lines.find((line) => line.item.itemId === items.scarf)!;
  const slideLine = list.lines.find((line) => line.item.itemId === items.slide)!;
  assert(scarfLine.needed === 12 && scarfLine.extra === 3 && scarfLine.inStock === 5 && scarfLine.toOrder === 10, `scarf: 12 + 3 - 5 = 10, got ${JSON.stringify(scarfLine)}`);
  assert(slideLine.needed === 12 && slideLine.toOrder === 12, `slide: 12 needed, none in stock, got ${JSON.stringify(slideLine)}`);
  const screen = applyExtras((await listOrderList(clubs.main)).lines, { [items.scarf]: "3" });
  assert(readableOrderCsv(list.lines) === readableOrderCsv(screen) && adventSourceOrderCsv(list.lines) === adventSourceOrderCsv(screen), "the pre-order exports equal the screen's lines with extras applied");
  const preOrder = parseCsvMatrix(adventSourceOrderCsv(list.lines));
  assert(preOrder.length === 3 && preOrder.some((row) => row[0] === "020001" && row[1] === "10") && preOrder.some((row) => row[0] === "020045" && row[1] === "12"), `AdventSource rows keep leading zeros, got ${JSON.stringify(preOrder)}`);
  console.log("ok  order math: needed + extras - stock (scarf 12 + 3 - 5 = 10, slide 12), exports match the screen, leading zeros kept");

  // ---------------------------------------------------------------- 4. placing, and the next order
  const batch = await createOrderBatch(clubs.main, { [items.scarf]: 3 }, actor);
  const orderedScarf = batch.lines.find((line) => line.item.itemId === items.scarf)!;
  assert(batch.needCount === 19 && orderedScarf.toOrder === 10, `19 needs ordered (5 scarves covered by stock stay needed), scarf 10; got ${JSON.stringify({ n: batch.needCount, s: orderedScarf.toOrder })}`);
  assert(await countNeeds(clubs.main, { status: "ORDERED", itemId: items.scarf }) === 7 && await countNeeds(clubs.main, { status: "NEEDED", itemId: items.scarf }) === 5, "7 scarf needs are ordered, the 5 stock covers stay needed");
  assert(await countNeeds(clubs.main, { status: "ORDERED", itemId: items.slide }) === 12, "all 12 slide needs are ordered");
  // Ordered items don't appear on the next order.
  const nextList = await listOrderList(clubs.main);
  const nextScarf = nextList.lines.find((line) => line.item.itemId === items.scarf);
  assert(!nextList.lines.some((line) => line.item.itemId === items.slide), "ordered slides are not on the next order list");
  assert(nextScarf?.needed === 5 && nextScarf.inStock === 5 && nextScarf.toOrder === 0, "only the still-needed scarves remain, covered by stock: nothing to order");
  await expectCode(createOrderBatch(clubs.main, {}, actor), "NOTHING_TO_ORDER", "a second order with everything ordered or in stock");
  assert(await prisma.clubSupplyOrderBatch.count({ where: { organizationId: clubs.main } }) === 1, "a refused order makes no batch");
  const audits = await prisma.auditLog.findMany({ where: { action: "CLUB_ORDER_PLACED", metadata: { path: ["organizationId"], equals: clubs.main } }, select: { metadata: true } });
  assert(audits.length === 1 && (audits[0].metadata as { needCount: number }).needCount === 19, "the order is audited with its count");
  console.log("ok  placing: ordered needs leave the list, stock-covered ones stay, the next order counts nothing twice, audited");

  // Newly recorded needs are the only thing the next order includes.
  const newcomers = await addMembers(clubs.main, 2);
  await recordUniformNeeds(clubs.main, { personIds: newcomers, itemIds: [items.slide], alreadyHasOne: false }, actor);
  const nextBatch = await createOrderBatch(clubs.main, {}, actor);
  const nextSlide = nextBatch.lines.find((line) => line.item.itemId === items.slide)!;
  assert(nextBatch.lines.length === 1 && nextSlide.needed === 2 && nextSlide.toOrder === 2, `the next order has only the 2 new slides, got ${JSON.stringify(nextBatch.lines)}`);
  console.log("ok  the next order includes only items still needed (2 new slides)");
  // Put those back into play for the receiving check below: receive both orders.
  await markOrderBatchReceived(clubs.main, nextBatch.batchId, actor);

  // ---------------------------------------------------------------- 5. receive, issue
  const received = await markOrderBatchReceived(clubs.main, batch.batchId, actor);
  assert(received.status === "RECEIVED", "the batch is received");
  assert(await stockOf(clubs.main, items.scarf) === 15, `scarf stock 5 + 10 = 15, got ${await stockOf(clubs.main, items.scarf)}`);
  assert(await stockOf(clubs.main, items.slide) === 14, `slide stock 12 + 2 = 14, got ${await stockOf(clubs.main, items.slide)}`);
  assert(await countNeeds(clubs.main, { status: "RECEIVED" }) === 21, "the ordered needs are now RECEIVED (7 scarves + 12 + 2 slides)");
  const receivedList = await listOrderList(clubs.main);
  const availableNow = receivedList.lines.find((line) => line.item.itemId === items.scarf)!;
  assert(availableNow.inStock === 15 - 7, `available = on hand - received-not-issued = 8, got ${availableNow.inStock}`);
  await expectCode(markOrderBatchReceived(clubs.main, batch.batchId, actor), "ALREADY_RECEIVED", "receiving twice");
  assert(await stockOf(clubs.main, items.scarf) === 15, "a refused second receive leaves stock alone");
  console.log("ok  receiving: ordered quantity joins stock, needs become RECEIVED, available = on hand - received-not-issued");

  const receivedScarves = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.main, status: "RECEIVED", itemId: items.scarf }, select: { id: true } });
  const issued = await markNeedsAwarded(clubs.main, receivedScarves.map((need) => need.id), actor);
  assert(issued.awarded === 7 && issued.fromStock === 0 && await stockOf(clubs.main, items.scarf) === 8, `issuing 7 received scarves takes 7 from stock (15 -> 8), got ${JSON.stringify(issued)} / ${await stockOf(clubs.main, items.scarf)}`);
  assert((await markNeedsAwarded(clubs.main, receivedScarves.map((need) => need.id), actor)).awarded === 0 && await stockOf(clubs.main, items.scarf) === 8, "issuing them again does nothing");
  console.log("ok  issuing: 7 received scarves leave stock (15 -> 8) exactly once");

  // Issuing straight from stock: the 5 still-NEEDED scarves are covered by the 8 in stock.
  const awardable = await listAwardableNeeds(clubs.main);
  const fromStock = awardable.filter((row) => row.itemId === items.scarf && row.fromStock);
  assert(fromStock.length === 5, `the 5 scarf needs stock covers are ready from stock, got ${fromStock.length}`);
  const stockIssue = await markNeedsAwarded(clubs.main, fromStock.slice(0, 2).map((row) => row.needId), actor);
  assert(stockIssue.awarded === 2 && stockIssue.fromStock === 2 && await stockOf(clubs.main, items.scarf) === 6, `2 issued straight from stock (8 -> 6), got ${JSON.stringify(stockIssue)}`);
  const fromStockAudit = await prisma.auditLog.findMany({ where: { action: "CLUB_ORDER_AWARDED", metadata: { path: ["organizationId"], equals: clubs.main } }, select: { metadata: true } });
  assert(fromStockAudit.some((row) => (row.metadata as { fromStockCount?: number }).fromStockCount === 2), "issuing from stock is audited with its count");
  console.log("ok  issuing straight from stock takes the unit from stock (8 -> 6), audited");

  // ---------------------------------------------------------------- 6. already has one
  const stockBefore = await stockOf(clubs.main, items.slide);
  const preExisting = await addMember(clubs.main);
  const alreadyRecorded = await recordUniformNeeds(clubs.main, { personIds: [preExisting], itemIds: [items.shirtM, items.slide], alreadyHasOne: true }, actor);
  assert(alreadyRecorded.created === 2 && alreadyRecorded.alreadyHadOne === 2, "the spreadsheet's 2 records two issued items");
  assert(await countNeeds(clubs.main, { personId: preExisting, status: "AWARDED" }) === 2, "recorded straight as issued");
  assert(await stockOf(clubs.main, items.slide) === stockBefore, "'already has one' never touches stock");
  const afterAlready = await listOrderList(clubs.main);
  assert(!afterAlready.lines.some((line) => line.item.itemId === items.shirtM), "'already has one' puts nothing on the order list");
  const laterNeed = await recordUniformNeeds(clubs.main, { personIds: [preExisting], itemIds: [items.shirtL], alreadyHasOne: false }, actor);
  assert(laterNeed.created === 1, "recording a different item for the same member");
  const laterId = (await prisma.clubOrderNeed.findFirstOrThrow({ where: { personId: preExisting, itemId: items.shirtL }, select: { id: true } })).id;
  const marked = await markNeedsAlreadyAwarded(clubs.main, [laterId], actor);
  assert(marked.marked === 1 && await countNeeds(clubs.main, { id: laterId, status: "AWARDED" }) === 1, "an existing need is marked already issued");
  assert(await stockOf(clubs.main, items.slide) === stockBefore && await stockOf(clubs.main, items.shirtL) === 0, "marking an existing need already issued leaves stock alone");
  assert(await prisma.auditLog.count({ where: { action: "CLUB_UNIFORM_NEEDS_RECORDED_ISSUED", metadata: { path: ["organizationId"], equals: clubs.main } } }) === 1, "the 'already has one' entry is audited");
  console.log("ok  'already has one': recorded or marked issued, stock untouched, nothing to order, audited");

  // ---------------------------------------------------------------- 7. removing a mistaken need
  const mistake = await addMember(clubs.main);
  await recordUniformNeeds(clubs.main, { personIds: [mistake], itemIds: [items.shirtM, items.shirtL], alreadyHasOne: false }, actor);
  const mistakeIds = (await prisma.clubOrderNeed.findMany({ where: { personId: mistake }, select: { id: true } })).map((need) => need.id);
  const receivedSlideNeed = (await prisma.clubOrderNeed.findFirstOrThrow({ where: { organizationId: clubs.main, status: "RECEIVED", itemId: items.slide }, select: { id: true } })).id;
  const removed = await removeUniformNeeds(clubs.main, [...mistakeIds, receivedSlideNeed], actor);
  assert(removed.removed === 2, `only the two NEEDED needs are removed, got ${removed.removed}`);
  assert(await countNeeds(clubs.main, { id: receivedSlideNeed, status: "RECEIVED" }) === 1, "a received need is never removed");
  assert((await removeUniformNeeds(clubs.main, mistakeIds, actor)).removed === 0, "removing again does nothing");
  assert(await prisma.auditLog.count({ where: { action: "CLUB_UNIFORM_NEEDS_REMOVED", metadata: { path: ["organizationId"], equals: clubs.main } } }) === 1, "the removal is audited once, by count");
  console.log("ok  removing: only not-yet-ordered uniform needs, audited by count");

  // ---------------------------------------------------------------- 8. combined honors + uniforms batch
  const comboMembers = await addMembers(clubs.combo, 3);
  for (const personId of comboMembers.slice(0, 2)) {
    await prisma.memberHonorEntry.create({ data: { personId, honorId, status: "COMPLETED", completionDate: "2026-09-20", organizationId: clubs.combo, recordedByUserId: staffUserId } });
  }
  await syncHonorOrderNeeds(clubs.combo);
  await recordUniformNeeds(clubs.combo, { personIds: comboMembers, itemIds: [items.shirtM], alreadyHasOne: false }, actor);
  await recordUniformNeeds(clubs.combo, { personIds: [comboMembers[0]], itemIds: [items.shirtL], alreadyHasOne: false }, actor);
  await syncHonorOrderNeeds(clubs.combo);
  assert(await countNeeds(clubs.combo, { sourceType: "UNIFORM" }) === 4 && await countNeeds(clubs.combo, { sourceType: "HONOR" }) === 2, "honors and uniforms each keep their own needs; a honor sync leaves uniform needs alone");
  const comboBatch = await createOrderBatch(clubs.combo, { [items.honorPatch]: 1 }, actor);
  assert(await prisma.clubSupplyOrderBatch.count({ where: { organizationId: clubs.combo } }) === 1 && comboBatch.lines.length === 3, "one batch holds the honor patch and both shirt sizes");
  const comboCsv = parseCsvMatrix(adventSourceOrderCsv((await getOrderBatch(clubs.combo, comboBatch.batchId)).lines));
  const asMap = Object.fromEntries(comboCsv.slice(1).map((row) => [row[0], row[1]]));
  assert(comboCsv[0].join() === "Catalog number,Quantity" && comboCsv.length === 4 && asMap["005157"] === "3" && asMap["011112"] === "3" && asMap["011113"] === "1", `one AdventSource file combines honors (2 + 1 extra) and uniforms, got ${JSON.stringify(comboCsv)}`);
  console.log("ok  a combined batch: one order, one AdventSource file with the honor patch and both shirt sizes");

  // The pick list: names, item, size, status only.
  const pick = await listPickList(clubs.combo, comboBatch.batchId);
  assert(pick.length === 6, `6 people-items on the pick list, got ${pick.length}`);
  for (const entry of pick) assert(Object.keys(entry).sort().join() === "firstName,itemName,lastName,size,status", `pick list entry keys, got ${Object.keys(entry).join()}`);
  const shirtEntry = pick.find((entry) => entry.itemName === "Boys' Short Sleeve Shirt" && entry.size === "L");
  assert(shirtEntry && shirtEntry.status === "Ordered", "the pick list splits the shirt into item and size");
  assert(pick.some((entry) => entry.itemName === "Camping Skills" && entry.size === ""), "an honor has no size");
  const workspace = await loadOrderWorkspace(clubs.combo);
  assert(workspace.waiting.every((need) => need.sourceType === "UNIFORM" || need.sourceType === "HONOR"), "waiting needs carry their source");
  console.log("ok  pick list: first name, last name, item, size, status only");

  // ---------------------------------------------------------------- 9. concurrency
  const racers = await addMembers(clubs.race, 4);
  await recordUniformNeeds(clubs.race, { personIds: racers, itemIds: [items.shirtM], alreadyHasOne: false }, actor);
  const placeResults = await Promise.allSettled([createOrderBatch(clubs.race, {}, actor), createOrderBatch(clubs.race, {}, actor)]);
  const placed = placeResults.filter((result) => result.status === "fulfilled");
  const refused = placeResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(placed.length === 1 && refused.length === 1 && refused[0].reason?.code === "NOTHING_TO_ORDER", "a double Place order makes one batch; the other tap is refused");
  const raceBatches = await prisma.clubSupplyOrderBatch.findMany({ where: { organizationId: clubs.race }, select: { id: true, lines: { select: { quantityOrdered: true } } } });
  assert(raceBatches.length === 1 && raceBatches[0].lines[0]?.quantityOrdered === 4, "exactly one batch ordering 4");
  const receiveResults = await Promise.allSettled([markOrderBatchReceived(clubs.race, raceBatches[0].id, actor), markOrderBatchReceived(clubs.race, raceBatches[0].id, actor)]);
  assert(receiveResults.filter((result) => result.status === "rejected").length === 1 && await stockOf(clubs.race, items.shirtM) === 4, "a double Mark received adds stock once");
  const raceNeedIds = (await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.race }, select: { id: true } })).map((need) => need.id);
  const issueResults = await Promise.all([markNeedsAwarded(clubs.race, raceNeedIds, actor), markNeedsAwarded(clubs.race, raceNeedIds, actor)]);
  assert(issueResults[0].awarded + issueResults[1].awarded === 4 && await stockOf(clubs.race, items.shirtM) === 0, "a double issue counts each need once and floors at zero");
  console.log("ok  double Place order / Mark received / issue: each happens once");

  const twins = await addMembers(clubs.race, 5);
  const entries = await Promise.all([
    recordUniformNeeds(clubs.race, { personIds: twins, itemIds: [items.scarf], alreadyHasOne: false }, actor),
    recordUniformNeeds(clubs.race, { personIds: twins, itemIds: [items.scarf], alreadyHasOne: false }, actor),
  ]);
  assert(entries[0].created + entries[1].created === 5 && entries[0].skipped + entries[1].skipped === 5, `a double-tapped bulk entry records 5 needs once, got ${JSON.stringify(entries)}`);
  assert(await countNeeds(clubs.race, { itemId: items.scarf }) === 5, "no duplicate needs from a double-tapped entry");
  // A bulk entry and a Place order at the same time serialize on the club lock: every need is either in the batch or still needed, never lost.
  const late = await addMembers(clubs.race, 3);
  const [, placeRace] = await Promise.allSettled([
    recordUniformNeeds(clubs.race, { personIds: late, itemIds: [items.slide], alreadyHasOne: false }, actor),
    createOrderBatch(clubs.race, {}, actor),
  ]);
  const raceTotal = await countNeeds(clubs.race, { itemId: items.slide });
  assert(raceTotal === 3, "the concurrent entry recorded all 3 needs");
  assert(placeRace.status === "fulfilled" || placeRace.reason?.code === "NOTHING_TO_ORDER", "the concurrent Place order either ordered or found nothing, never errored");
  console.log("ok  a double-tapped bulk entry records once; an entry racing a Place order loses nothing");

  // ---------------------------------------------------------------- 10. view-only writes nothing; member scoping
  const viewMembers = await addMembers(clubs.view, 2);
  await recordUniformNeeds(clubs.view, { personIds: viewMembers, itemIds: [items.scarf], alreadyHasOne: false }, actor);
  const writesBefore = { needs: await prisma.clubOrderNeed.count(), audits: await prisma.auditLog.count(), stock: await prisma.clubSupplyStock.count(), batches: await prisma.clubSupplyOrderBatch.count() };
  const viewOnly = await loadUniformWorkspace(clubs.view, { forEditing: false });
  await loadOrderWorkspace(clubs.view);
  const writesAfter = { needs: await prisma.clubOrderNeed.count(), audits: await prisma.auditLog.count(), stock: await prisma.clubSupplyStock.count(), batches: await prisma.clubSupplyOrderBatch.count() };
  assert(JSON.stringify(writesBefore) === JSON.stringify(writesAfter), "a view-only load writes nothing");
  assert(viewOnly.catalog.length === 0 && viewOnly.members.length === 0 && viewOnly.needs.length === 2, "a view-only load gets the open needs, no picker and no member list");
  for (const row of viewOnly.needs) assert(Object.keys(row).sort().join() === "firstName,itemName,lastName,needId,personId,size,status", `open need row carries names, item, size, status only, got ${Object.keys(row).join()}`);
  const editing = await loadUniformWorkspace(clubs.view, { forEditing: true });
  assert(editing.members.length === 2 && editing.catalog.length === 3, `an editor gets the picker (Boys' shirt, Adult Scarf, Adult Slide) and the roster, got ${editing.catalog.length}`);
  assert(editing.catalog.find((group) => group.baseName === "Boys' Short Sleeve Shirt")?.variants.map((variant) => variant.size).join() === "M,L", "size variants are grouped under the base item");
  assert(!editing.catalog.some((group) => group.variants.some((variant) => [items.honorPatch, items.camporee, items.inactive].includes(variant.itemId))), "only active uniform items are offered");
  const otherClubWorkspace = await loadUniformWorkspace(clubs.other, { forEditing: true });
  assert(otherClubWorkspace.needs.length === 0 && otherClubWorkspace.members.length === 1, "another club sees only its own needs and members");
  console.log("ok  view-only: writes nothing, sees names/item/size/status only, no picker; another club's data stays separate");

  // ---------------------------------------------------------------- 11. "already has one" settles existing needs
  const [m0, m1] = await addMembers(clubs.mark, 2);
  await recordUniformNeeds(clubs.mark, { personIds: [m0], itemIds: [items.shirtM], alreadyHasOne: false }, actor);
  await createOrderBatch(clubs.mark, {}, actor);
  await recordUniformNeeds(clubs.mark, { personIds: [m0, m1], itemIds: [items.slide], alreadyHasOne: false }, actor);
  const markStock = await prisma.clubSupplyStock.count({ where: { organizationId: clubs.mark } });
  const settle = { personIds: [m0, m1], itemIds: [items.shirtM, items.slide], alreadyHasOne: true };
  const settled = await Promise.all([recordUniformNeeds(clubs.mark, settle, actor), recordUniformNeeds(clubs.mark, settle, actor)]);
  assert(settled[0].marked + settled[1].marked === 2, `the 2 existing NEEDED slide needs move to issued exactly once, got ${JSON.stringify(settled)}`);
  assert(settled[0].created + settled[1].created === 1, `one new issued shirt for the member with no need, got ${JSON.stringify(settled)}`);
  assert(await countNeeds(clubs.mark, { itemId: items.slide, status: "AWARDED" }) === 2 && await countNeeds(clubs.mark, { itemId: items.slide, status: "NEEDED" }) === 0, "both slide needs are issued");
  assert(await countNeeds(clubs.mark, { itemId: items.shirtM, personId: m0, status: "ORDERED" }) === 1, "an already-ordered need is left alone");
  assert(await countNeeds(clubs.mark, { itemId: items.shirtM }) === 2, "no duplicate issued records from the double tap");
  assert(await prisma.clubSupplyStock.count({ where: { organizationId: clubs.mark } }) === markStock && await stockOf(clubs.mark, items.slide) === 0, "settling needs never touches stock");
  const markAudits = await prisma.auditLog.findMany({ where: { action: "CLUB_ORDER_MARKED_ALREADY_AWARDED", metadata: { path: ["organizationId"], equals: clubs.mark } }, select: { metadata: true } });
  assert(markAudits.length === 1 && (markAudits[0].metadata as { needCount: number }).needCount === 2, "the marked needs are audited by count");
  console.log("ok  'already has one' moves existing NEEDED needs to issued (guarded, once, no stock change, audited by count)");

  // ---------------------------------------------------------------- 12. departed members' needs
  const stays = await addMember(clubs.depart);
  const leaves = await addMember(clubs.depart);
  const leavesOrdered = await addMember(clubs.depart);
  await recordUniformNeeds(clubs.depart, { personIds: [leavesOrdered], itemIds: [items.shirtL], alreadyHasOne: false }, actor);
  await createOrderBatch(clubs.depart, {}, actor);
  await recordUniformNeeds(clubs.depart, { personIds: [stays, leaves, leavesOrdered], itemIds: [items.shirtM], alreadyHasOne: false }, actor);
  // "leaves" transfers to another club; "leavesOrdered" is deactivated.
  await prisma.clubRosterMember.updateMany({ where: { personId: leaves }, data: { status: "INACTIVE" } });
  await prisma.clubRosterMember.updateMany({ where: { personId: leavesOrdered }, data: { status: "INACTIVE" } });
  await prisma.clubRosterMember.create({ data: { id: `${leaves}_at_moved`, organizationId: clubs.moved, clubYear: thisClubYear, personId: leaves, attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", status: "ACTIVE", source: "DIRECTOR" } });
  await loadUniformWorkspace(clubs.depart, { forEditing: false });
  assert(await countNeeds(clubs.depart, { itemId: items.shirtM }) === 3, "a view-only load removes nothing");
  await loadUniformWorkspace(clubs.depart, { forEditing: true });
  assert(await countNeeds(clubs.depart, { itemId: items.shirtM }) === 1 && await countNeeds(clubs.depart, { itemId: items.shirtM, personId: stays }) === 1, "an editor's load removes the NEEDED needs of members no longer active");
  assert(await countNeeds(clubs.depart, { itemId: items.shirtL, personId: leavesOrdered, status: "ORDERED" }) === 1, "an ORDERED need of a departed member stays");
  assert(await countNeeds(clubs.moved) === 0, "needs are not moved to the new club");
  const departAudits = await prisma.auditLog.findMany({ where: { action: "CLUB_UNIFORM_NEEDS_DEPARTED_REMOVED", metadata: { path: ["organizationId"], equals: clubs.depart } }, select: { metadata: true } });
  assert(departAudits.length === 1 && (departAudits[0].metadata as { needCount: number }).needCount === 2, "the removal is audited by count");
  // Placing an order also never orders a departed member's need.
  await prisma.clubRosterMember.updateMany({ where: { personId: stays }, data: { status: "INACTIVE" } });
  await expectCode(createOrderBatch(clubs.depart, {}, actor), "NOTHING_TO_ORDER", "ordering with only a departed member's need");
  assert(await countNeeds(clubs.depart, { itemId: items.shirtM }) === 0, "Place order dropped the departed member's need instead of ordering it");
  console.log("ok  departed members: NEEDED uniform needs removed on an editor's load or order (audited by count), ORDERED stay, none moved");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
