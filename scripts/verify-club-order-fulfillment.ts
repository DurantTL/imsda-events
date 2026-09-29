/**
 * Proves club order fulfillment (#487) against a real PostgreSQL database:
 * syncing a club's completed honors into needs is idempotent and keyed on
 * the person and honor; the order list math (needed, extras, available
 * stock, to order) matches what gets ordered, exported, and received; a
 * double "Place order", "Mark received", or "Mark awarded" never creates a
 * phantom batch or moves stock twice; a full cycle leaves exactly the extras
 * in stock; a need stock already covers can be handed out from stock;
 * "Already handed out" moves needs without touching stock; a NEEDED need
 * follows a transferred member while an ordered one stays; views never
 * write; and the Honors Weekend write-back is idempotent, never duplicates a
 * hand-recorded completion, and survives two runs at once. Uses fictitious
 * rows it creates and removes itself.
 *
 *   npm run test:club-orders
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { clubYearFor } from "../modules/club-rosters/domain";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "corder";
const staffUserId = `${P}_staff`;
const eventId = `${P}_event`;
const clubs = {
  main: `${P}_club`,
  race: `${P}_club_race`,
  stock: `${P}_club_stock`,
  reserved: `${P}_club_reserved`,
  weekend: `${P}_club_weekend`,
  other: `${P}_club_other`,
  handout: `${P}_club_handout`,
  from: `${P}_club_from`,
  to: `${P}_club_to`,
  link: `${P}_club_link`,
  stale: `${P}_club_stale`,
};
const honors = {
  linked: `${P}_honor_linked`,
  unnumbered: `${P}_honor_unnumbered`,
  unmatched: `${P}_honor_unmatched`,
  weekend: `${P}_honor_weekend`,
  fire: `${P}_honor_fire`,
  cooking: `${P}_honor_cooking`,
  late: `${P}_honor_late`,
};
const items = {
  linked: `${P}_item_linked`,
  unnumbered: `${P}_item_unnumbered`,
  weekend: `${P}_item_weekend`,
  fire: `${P}_item_fire`,
  cooking: `${P}_item_cooking`,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(error && typeof error === "object" && "code" in error && (error as { code: string }).code === code, `${message}: expected ${code}, got ${String(error)}`);
}

const startsWithP = { startsWith: `${P}_` };

async function cleanup() {
  const enrollments = await prisma.honorEnrollment.findMany({ where: { eventId: startsWithP }, select: { id: true } });
  await prisma.honorWeekendCompletionLink.deleteMany({ where: { enrollmentId: { in: enrollments.map((row) => row.id) } } });
  await prisma.checkIn.deleteMany({ where: { eventId: startsWithP } });
  await prisma.honorEnrollment.deleteMany({ where: { eventId: startsWithP } });
  await prisma.registrationAttendee.deleteMany({ where: { eventId: startsWithP } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: startsWithP } });
  await prisma.registration.deleteMany({ where: { eventId: startsWithP } });
  await prisma.honorOffering.deleteMany({ where: { eventId: startsWithP } });
  await prisma.honorSession.deleteMany({ where: { eventId: startsWithP } });
  await prisma.event.deleteMany({ where: { id: startsWithP } });
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

async function addPerson(key: string, firstName: string, lastName: string) {
  const id = `${P}_person_${key}`;
  await prisma.person.create({ data: { id, firstName, lastName } });
  return id;
}

const thisClubYear = clubYearFor(new Date());

async function addMember(organizationId: string, personId: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE", clubYear = thisClubYear) {
  return prisma.clubRosterMember.create({
    data: {
      id: `${personId}_at_${organizationId}_${clubYear}`, organizationId, clubYear, personId,
      attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", status, source: "DIRECTOR",
    },
    select: { id: true },
  });
}

async function complete(personId: string, honorId: string, organizationId: string, completionDate = "2026-09-20") {
  return prisma.memberHonorEntry.create({
    data: { personId, honorId, status: "COMPLETED", completionDate, organizationId, recordedByUserId: staffUserId },
    select: { id: true },
  });
}

/** A club with `count` active members who have each completed `honorId`. */
async function clubWithCompletions(organizationId: string, key: string, honorId: string, count: number) {
  const personIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const personId = await addPerson(`${key}_${index}`, `Member${index}`, `${key[0].toUpperCase()}${key.slice(1)}`);
    await addMember(organizationId, personId);
    await complete(personId, honorId, organizationId);
    personIds.push(personId);
  }
  return personIds;
}

async function stockOf(organizationId: string, itemId: string) {
  const row = await prisma.clubSupplyStock.findUnique({ where: { organizationId_itemId: { organizationId, itemId } }, select: { quantityOnHand: true } });
  return row?.quantityOnHand ?? 0;
}

async function main() {
  const { honorNeedSourceId, syncHonorOrderNeeds } = await import("../modules/honors/order-source");
  const { writeBackHonorsWeekendCompletions } = await import("../modules/honors/weekend-completion-repository");
  const {
    createOrderBatch,
    getOrderBatch,
    listAwardableNeeds,
    listOrderBatches,
    listOrderList,
    listPickList,
    loadOrderWorkspace,
    markNeedsAlreadyAwarded,
    markNeedsAwarded,
    markOrderBatchReceived,
  } = await import("../modules/club-orders/repository");
  const { removeRosterMember } = await import("../modules/club-rosters/repository");
  const { adventSourceOrderCsv, applyExtras, readableOrderCsv } = await import("../modules/club-orders/domain");
  const { parseCsvMatrix } = await import("../modules/imports/csv-parser");

  await cleanup();
  const actor = { userId: staffUserId, actAsId: `${P}_actas` };

  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Order Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.createMany({
    data: Object.entries(clubs).map(([key, id]) => ({ id, type: "CLUB" as const, name: `Order Check ${key} Club`, normalizedName: `order check ${key} club` })),
  });
  await prisma.honor.createMany({
    data: [
      { id: honors.linked, code: `${P.toUpperCase()}-1`, name: "Camping Skills", normalizedName: "camping skills" },
      { id: honors.unnumbered, code: `${P.toUpperCase()}-2`, name: "Wilderness Living", normalizedName: "wilderness living" },
      { id: honors.unmatched, code: `${P.toUpperCase()}-3`, name: "Orienteering", normalizedName: "orienteering" },
      { id: honors.weekend, code: `${P.toUpperCase()}-4`, name: "Knot Tying", normalizedName: "knot tying" },
      { id: honors.fire, code: `${P.toUpperCase()}-5`, name: "Fire Building", normalizedName: "fire building" },
      { id: honors.cooking, code: `${P.toUpperCase()}-6`, name: "Camp Cooking", normalizedName: "camp cooking" },
      { id: honors.late, code: `${P.toUpperCase()}-7`, name: "Birds", normalizedName: "birds" },
    ],
  });
  await prisma.clubSupplyItem.createMany({
    data: [
      { id: items.linked, section: "OUTDOOR_INDUSTRIES", name: "Camping Skills", normalizedName: `${P} camping skills`, catalogNumber: "005157", honorId: honors.linked },
      { id: items.unnumbered, section: "OUTDOOR_INDUSTRIES", name: "Wilderness Living", normalizedName: `${P} wilderness living`, catalogNumber: null, honorId: honors.unnumbered },
      { id: items.weekend, section: "OUTDOOR_INDUSTRIES", name: "Knot Tying", normalizedName: `${P} knot tying`, catalogNumber: "002120", honorId: honors.weekend },
      { id: items.fire, section: "OUTDOOR_INDUSTRIES", name: "Fire Building", normalizedName: `${P} fire building`, catalogNumber: "003300", honorId: honors.fire },
      { id: items.cooking, section: "OUTDOOR_INDUSTRIES", name: "Camp Cooking", normalizedName: `${P} camp cooking`, catalogNumber: "004400", honorId: honors.cooking },
    ],
  });

  // ---------------------------------------------------------------- the basic flow
  const alex = await addPerson("alex", "Alex", "Sample");
  const casey = await addPerson("casey", "Casey", "Demo");
  const drew = await addPerson("drew", "Drew", "Placeholder");
  for (const personId of [alex, casey, drew]) await addMember(clubs.main, personId);
  await complete(alex, honors.linked, clubs.main);
  await complete(casey, honors.unnumbered, clubs.main);
  await complete(drew, honors.unmatched, clubs.main);

  // 1. Syncing is idempotent and keyed on the person and honor.
  await syncHonorOrderNeeds(clubs.main);
  await syncHonorOrderNeeds(clubs.main);
  const mainNeeds = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.main }, select: { sourceId: true, sourceLabel: true, sourceDate: true } });
  assert(mainNeeds.length === 3, `expected 3 needs after syncing twice, found ${mainNeeds.length}`);
  assert(mainNeeds.some((need) => need.sourceId === honorNeedSourceId(alex, honors.linked) && need.sourceLabel === "Camping Skills" && need.sourceDate === "2026-09-20"),
    "a need is keyed personId:honorId and carries the honor's name and completion date");
  console.log("ok  syncing completed honors into needs is idempotent (3 needs, not 6), keyed on person and honor");

  // 2. The order list: needed/extra/stock math, and the unmatched honor flagged separately.
  const list = await listOrderList(clubs.main);
  assert(list.unmatched.length === 1 && list.unmatched[0].personId === drew, "Orienteering (no catalog item) should come back unmatched");
  const linkedLine = list.lines.find((line) => line.item.itemId === items.linked)!;
  const unnumberedLine = list.lines.find((line) => line.item.itemId === items.unnumbered)!;
  assert(linkedLine.needed === 1 && linkedLine.toOrder === 1 && !linkedLine.missingCatalogNumber, "Camping Skills should need 1, order 1, with a catalog number");
  assert(unnumberedLine.needed === 1 && unnumberedLine.missingCatalogNumber, "Wilderness Living should be flagged for no AdventSource number");
  console.log("ok  order list: needed/extra/stock math correct, no-catalog-number item flagged, unmatched honor separate");

  // 3. Placing an order moves matched needs to ORDERED and leaves the unmatched one alone.
  const batch = await createOrderBatch(clubs.main, { [items.linked]: 2 }, actor);
  const orderedLine = batch.lines.find((line) => line.item.itemId === items.linked)!;
  assert(orderedLine.needed === 1 && orderedLine.extra === 2 && orderedLine.toOrder === 3, `expected needed 1 + extra 2 = 3 to order, got ${JSON.stringify(orderedLine)}`);
  const afterOrder = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.main }, select: { status: true, itemId: true } });
  assert(afterOrder.filter((need) => need.status === "ORDERED").length === 2, "the two matched needs should now be ORDERED");
  assert(afterOrder.find((need) => need.itemId === null)?.status === "NEEDED", "the unmatched need is untouched by ordering");
  console.log("ok  placing an order: extras applied, matched needs move to ORDERED, unmatched need untouched");

  // 4. Nothing left to order (only the unmatched, unorderable need remains): refused, and no batch is created.
  await expectCode(createOrderBatch(clubs.main, {}, actor), "NOTHING_TO_ORDER", "a second order with nothing pending");
  assert((await prisma.clubSupplyOrderBatch.count({ where: { organizationId: clubs.main } })) === 1, "a refused order creates no batch");
  console.log("ok  placing an order with nothing to order is refused, and creates no batch");

  // 5. The AdventSource export never carries an item with no catalog number; the readable list still shows it.
  const batchDetail = await getOrderBatch(clubs.main, batch.batchId);
  const adventSourceRows = parseCsvMatrix(adventSourceOrderCsv(batchDetail.lines));
  assert(adventSourceRows.length === 2 && adventSourceRows[1][0] === "005157" && adventSourceRows[1][1] === "3", `AdventSource export should have one data row for 005157 x3, got ${JSON.stringify(adventSourceRows)}`);
  const readableRows = parseCsvMatrix(readableOrderCsv(batchDetail.lines));
  assert(readableRows.length === 3, "the readable order list should include both items");
  console.log("ok  AdventSource export: two columns, one row (no catalog number excluded); readable list keeps both");

  // 6. Receiving adds the ordered quantity to stock, and is refused a second time.
  const received = await markOrderBatchReceived(clubs.main, batch.batchId, actor);
  assert(received.status === "RECEIVED", "the batch should be RECEIVED");
  assert(await stockOf(clubs.main, items.linked) === 3, "Camping Skills stock should be 3 (1 needed + 2 extra)");
  assert(await stockOf(clubs.main, items.unnumbered) === 1, "Wilderness Living stock should be 1 (1 needed, no extra)");
  await expectCode(markOrderBatchReceived(clubs.main, batch.batchId, actor), "ALREADY_RECEIVED", "receiving the same order twice");
  assert(await stockOf(clubs.main, items.linked) === 3, "a refused second receive leaves stock alone");
  console.log("ok  receiving: ordered quantity added to stock, and it's refused a second time");

  // 7. The pick list carries only names, the item, and where it stands.
  const pickList = await listPickList(clubs.main, batch.batchId);
  assert(pickList.length === 2, `expected 2 pick-list entries, found ${pickList.length}`);
  for (const entry of pickList) {
    assert(Object.keys(entry).sort().join() === "firstName,itemName,lastName,size,status", `pick list entry should carry only names, the item, its size, and status, got ${Object.keys(entry).join()}`);
  }
  assert(pickList.some((entry) => entry.firstName === "Alex" && entry.itemName === "Camping Skills" && entry.status === "Ready to hand out"), "Alex should be on the pick list for Camping Skills, ready to hand out");
  console.log("ok  pick list: names, the item, and status only, no birth date, contact, guardian, or medical field");

  const awardable = await listAwardableNeeds(clubs.main);
  assert(awardable.length === 2 && awardable.every((row) => Object.keys(row).sort().join() === "firstName,fromStock,itemId,itemName,lastName,needId"), "awardable needs carry names, the item, and ids only");
  const history = await listOrderBatches(clubs.main);
  assert(history.length === 1 && history[0].status === "RECEIVED" && history[0].totalQuantity === 4, "order history shows the received order (3 + 1)");
  console.log("ok  order history and awardable list: names and items only");

  // 8. Awarding decrements stock by one per need, and never below zero.
  const receivedNeeds = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.main, status: "RECEIVED" }, select: { id: true, itemId: true } });
  const linkedNeed = receivedNeeds.find((need) => need.itemId === items.linked)!;
  const unnumberedNeed = receivedNeeds.find((need) => need.itemId === items.unnumbered)!;
  assert((await markNeedsAwarded(clubs.main, [linkedNeed.id], actor)).awarded === 1, "one need should be marked awarded");
  assert(await stockOf(clubs.main, items.linked) === 2, "Camping Skills stock drops to 2: the extras");
  assert((await markNeedsAwarded(clubs.main, [linkedNeed.id], actor)).awarded === 0, "re-awarding an already-awarded need should do nothing");
  assert(await stockOf(clubs.main, items.linked) === 2, "stock should not drop a second time");
  await prisma.clubSupplyStock.update({ where: { organizationId_itemId: { organizationId: clubs.main, itemId: items.unnumbered } }, data: { quantityOnHand: 0 } });
  await markNeedsAwarded(clubs.main, [unnumberedNeed.id], actor);
  assert(await stockOf(clubs.main, items.unnumbered) === 0, "stock should floor at 0");
  console.log("ok  awarding: decrements stock by one per need, idempotent, and never goes below zero");

  // ---------------------------------------------------------------- finding 1, 2, 4: double taps
  const racePeople = await clubWithCompletions(clubs.race, "race", honors.linked, 3);
  await syncHonorOrderNeeds(clubs.race);
  const placeResults = await Promise.allSettled([
    createOrderBatch(clubs.race, {}, actor),
    createOrderBatch(clubs.race, {}, actor),
  ]);
  const placed = placeResults.filter((result) => result.status === "fulfilled");
  const refused = placeResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(placed.length === 1 && refused.length === 1 && refused[0].reason?.code === "NOTHING_TO_ORDER",
    `two concurrent "Place order" taps should make one batch and refuse the other, got ${JSON.stringify(placeResults.map((result) => result.status))}`);
  const raceBatches = await prisma.clubSupplyOrderBatch.findMany({ where: { organizationId: clubs.race }, select: { id: true, lines: { select: { quantityOrdered: true } } } });
  assert(raceBatches.length === 1 && raceBatches[0].lines[0]?.quantityOrdered === 3, `expected exactly one batch ordering 3, got ${JSON.stringify(raceBatches)}`);
  console.log("ok  double \"Place order\": one batch, the other tap refused with NOTHING_TO_ORDER (no phantom batch)");

  const receiveResults = await Promise.allSettled([
    markOrderBatchReceived(clubs.race, raceBatches[0].id, actor),
    markOrderBatchReceived(clubs.race, raceBatches[0].id, actor),
  ]);
  const receiveRefused = receiveResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(receiveRefused.length === 1 && receiveRefused[0].reason?.code === "ALREADY_RECEIVED", "two concurrent \"Mark received\" taps: one refused ALREADY_RECEIVED");
  assert(await stockOf(clubs.race, items.linked) === 3, `stock added once (3), got ${await stockOf(clubs.race, items.linked)}`);
  console.log("ok  double \"Mark received\": stock added once, the other tap refused with ALREADY_RECEIVED");

  const raceNeedIds = (await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.race }, select: { id: true } })).map((need) => need.id);
  assert(raceNeedIds.length === racePeople.length, "one need per racer");
  const awardResults = await Promise.all([
    markNeedsAwarded(clubs.race, raceNeedIds, actor),
    markNeedsAwarded(clubs.race, raceNeedIds, actor),
  ]);
  assert(awardResults[0].awarded + awardResults[1].awarded === 3, `concurrent awards of the same needs count each once, got ${JSON.stringify(awardResults)}`);
  assert(await stockOf(clubs.race, items.linked) === 0, `stock drops by 3 exactly once, got ${await stockOf(clubs.race, items.linked)}`);
  const awardAudits = await prisma.auditLog.findMany({ where: { action: "CLUB_ORDER_AWARDED", metadata: { path: ["organizationId"], equals: clubs.race } }, select: { metadata: true } });
  assert(awardAudits.length === 1 && (awardAudits[0].metadata as { needCount: number }).needCount === 3, "one audit row with the actual count");
  console.log("ok  concurrent \"Mark awarded\": each need counted once, stock decremented in SQL once, one audit row");

  // ---------------------------------------------------------------- finding 3, 5: stock at order time, full cycle
  await clubWithCompletions(clubs.stock, "stock", honors.fire, 5);
  await prisma.clubSupplyStock.create({ data: { organizationId: clubs.stock, itemId: items.fire, quantityOnHand: 2 } });
  await syncHonorOrderNeeds(clubs.stock);
  const stockList = await listOrderList(clubs.stock);
  const fireLine = stockList.lines.find((line) => line.item.itemId === items.fire)!;
  assert(fireLine.needed === 5 && fireLine.inStock === 2 && fireLine.toOrder === 3, `5 needed, 2 in stock: order 3, got ${JSON.stringify(fireLine)}`);

  // Finding 7 (real data): the export with extras equals the screen's lines with the same extras applied.
  const screenLines = applyExtras(stockList.lines, { [items.fire]: "1" });
  const exportLines = (await listOrderList(clubs.stock, new Map([[items.fire, 1]]))).lines;
  assert(readableOrderCsv(exportLines) === readableOrderCsv(screenLines) && adventSourceOrderCsv(exportLines) === adventSourceOrderCsv(screenLines),
    "the top-level exports with extras equal the screen's lines with extras applied");
  assert(parseCsvMatrix(adventSourceOrderCsv(exportLines))[1]?.[1] === "4", "with 1 extra the pre-order AdventSource file says 4");
  console.log("ok  top-level exports with the typed extras match the screen exactly (order 4)");

  const stockAwardableBefore = await listAwardableNeeds(clubs.stock);
  assert(stockAwardableBefore.length === 2 && stockAwardableBefore.every((need) => need.fromStock), "the 2 needs stock covers are ready to hand out from stock");
  const stockBatch = await createOrderBatch(clubs.stock, { [items.fire]: 1 }, actor);
  assert(stockBatch.lines[0].toOrder === 4 && stockBatch.needCount === 3, `order 4 (5 + 1 - 2), moving 3 needs; got ${JSON.stringify(stockBatch)}`);
  const stockBatchCsv = parseCsvMatrix(adventSourceOrderCsv((await getOrderBatch(clubs.stock, stockBatch.batchId)).lines));
  assert(stockBatchCsv[1]?.[0] === "003300" && stockBatchCsv[1]?.[1] === "4", `the batch AdventSource file says 4, got ${JSON.stringify(stockBatchCsv)}`);
  const stockReadable = parseCsvMatrix(readableOrderCsv((await getOrderBatch(clubs.stock, stockBatch.batchId)).lines));
  assert(stockReadable[1]?.[2] === "4", "the batch readable list says 4 to order");
  await markOrderBatchReceived(clubs.stock, stockBatch.batchId, actor);
  assert(await stockOf(clubs.stock, items.fire) === 6, `receiving adds exactly 4 (2 + 4 = 6), got ${await stockOf(clubs.stock, items.fire)}`);
  const afterReceiveList = await listOrderList(clubs.stock);
  assert(afterReceiveList.lines[0]?.toOrder === 0, "after receiving, the stock-covered needs need nothing more ordered");
  const readyAll = await listAwardableNeeds(clubs.stock);
  assert(readyAll.length === 5 && readyAll.filter((need) => need.fromStock).length === 2, "ready to hand out: 3 received + 2 from stock");
  const fromStockIds = readyAll.filter((need) => need.fromStock).map((need) => need.needId);
  const fromStockAwards = await Promise.all([markNeedsAwarded(clubs.stock, fromStockIds, actor), markNeedsAwarded(clubs.stock, fromStockIds, actor)]);
  assert(fromStockAwards.reduce((sum, result) => sum + result.fromStock, 0) === 2, "two concurrent from-stock awards count once");
  assert(await stockOf(clubs.stock, items.fire) === 4, `handing out 2 from stock leaves 4, got ${await stockOf(clubs.stock, items.fire)}`);
  await markNeedsAwarded(clubs.stock, readyAll.filter((need) => !need.fromStock).map((need) => need.needId), actor);
  assert(await stockOf(clubs.stock, items.fire) === 1, `after the full cycle stock equals the extras (1), got ${await stockOf(clubs.stock, items.fire)}`);
  const fromStockAudit = await prisma.auditLog.findFirst({ where: { action: "CLUB_ORDER_AWARDED", metadata: { path: ["fromStockCount"], equals: 2 } }, select: { id: true } });
  assert(fromStockAudit, "the from-stock award is audited with its count");
  console.log("ok  stock at order time: screen, batch files, and receive all say 4; full cycle leaves exactly the extras (1)");
  console.log("ok  a need stock covers goes NEEDED -> AWARDED from stock, decrementing stock once, audited");

  // Received-but-not-awarded units are reserved, not free stock.
  await clubWithCompletions(clubs.reserved, "reserved", honors.fire, 3);
  await syncHonorOrderNeeds(clubs.reserved);
  const reservedBatch = await createOrderBatch(clubs.reserved, {}, actor);
  await markOrderBatchReceived(clubs.reserved, reservedBatch.batchId, actor);
  await clubWithCompletions(clubs.reserved, "reservedlate", honors.fire, 2);
  await syncHonorOrderNeeds(clubs.reserved);
  const reservedLine = (await listOrderList(clubs.reserved)).lines[0];
  assert(reservedLine?.needed === 2 && reservedLine.inStock === 0 && reservedLine.toOrder === 2, `3 received-unawarded + 2 new: order 2, got ${JSON.stringify(reservedLine)}`);
  const lateNeed = await prisma.clubOrderNeed.findFirst({ where: { organizationId: clubs.reserved, status: "NEEDED" }, select: { id: true } });
  await expectCode(markNeedsAwarded(clubs.reserved, [lateNeed!.id], actor), "NOT_ENOUGH_STOCK", "handing out from stock that's set aside for others");
  console.log("ok  received-but-unawarded units are set aside: 3 received + 2 new completions orders 2, and can't be handed out from stock");

  // ---------------------------------------------------------------- design: "Already handed out"
  await clubWithCompletions(clubs.handout, "handout", honors.linked, 3);
  await syncHonorOrderNeeds(clubs.handout);
  const handoutWorkspace = await loadOrderWorkspace(clubs.handout);
  assert(handoutWorkspace.firstOrderAt === null && handoutWorkspace.waiting.length === 3 && handoutWorkspace.waiting.every((need) => need.beforeFirstOrder),
    "with no order yet, every waiting need is offered as completed before ordering here");
  const handoutIds = handoutWorkspace.waiting.slice(0, 2).map((need) => need.needId);
  assert((await markNeedsAlreadyAwarded(clubs.handout, handoutIds, actor)).marked === 2, "two needs marked already handed out");
  assert((await markNeedsAlreadyAwarded(clubs.handout, handoutIds, actor)).marked === 0, "marking them again does nothing");
  assert((await prisma.clubSupplyStock.count({ where: { organizationId: clubs.handout } })) === 0, "already handed out never touches stock");
  const handoutAudit = await prisma.auditLog.findMany({ where: { action: "CLUB_ORDER_MARKED_ALREADY_AWARDED", metadata: { path: ["organizationId"], equals: clubs.handout } }, select: { metadata: true } });
  assert(handoutAudit.length === 1 && (handoutAudit[0].metadata as { needCount: number }).needCount === 2, "audited once as CLUB_ORDER_MARKED_ALREADY_AWARDED with the count");
  await createOrderBatch(clubs.handout, {}, actor);
  await clubWithCompletions(clubs.handout, "handoutlate", honors.linked, 1);
  await syncHonorOrderNeeds(clubs.handout);
  const handoutLater = await loadOrderWorkspace(clubs.handout);
  assert(handoutLater.firstOrderAt !== null && handoutLater.waiting.length === 1 && !handoutLater.waiting[0].beforeFirstOrder,
    "a completion after the first order isn't offered as 'before you started ordering here'");
  console.log("ok  \"Already handed out\": NEEDED -> AWARDED without stock, audited with a count; the prompt covers only needs before the first order");

  // Views never write: a new completion stays off file until an editor's visit syncs.
  const quiet = await addPerson("quiet", "Quinn", "Viewonly");
  await addMember(clubs.handout, quiet);
  await complete(quiet, honors.linked, clubs.handout);
  const beforeView = await prisma.clubOrderNeed.count({ where: { organizationId: clubs.handout } });
  await loadOrderWorkspace(clubs.handout);
  await listOrderList(clubs.handout);
  await listPickList(clubs.handout);
  assert(await prisma.clubOrderNeed.count({ where: { organizationId: clubs.handout } }) === beforeView, "reading the order screen writes nothing");
  console.log("ok  reading the order screen, list, and pick list writes nothing");

  // Top-level pick list: who's to order, and who's ready to hand out, labelled.
  const topPick = await listPickList(clubs.stock);
  assert(topPick.length === 0, "a fully handed-out club has an empty top-level pick list");
  const reservedPick = await listPickList(clubs.reserved);
  assert(reservedPick.filter((entry) => entry.status === "Ready to hand out").length === 3 && reservedPick.filter((entry) => entry.status === "To order").length === 2,
    "the top-level pick list lists 3 ready to hand out and 2 to order, labelled");
  console.log("ok  top-level pick list: to order and ready to hand out, labelled");

  // ---------------------------------------------------------------- design: transfers
  const tay = await addPerson("tay", "Tay", "Mover");
  const tayAtFrom = await addMember(clubs.from, tay);
  await complete(tay, honors.linked, clubs.from);
  await complete(tay, honors.cooking, clubs.from);
  await prisma.clubSupplyStock.create({ data: { organizationId: clubs.from, itemId: items.cooking, quantityOnHand: 1 } });
  await syncHonorOrderNeeds(clubs.from);
  await createOrderBatch(clubs.from, {}, actor); // Camping Skills ordered; Camp Cooking covered by stock, stays NEEDED.
  await prisma.clubRosterMember.update({ where: { id: tayAtFrom.id }, data: { status: "INACTIVE" } });
  await addMember(clubs.to, tay);
  await syncHonorOrderNeeds(clubs.to);
  const tayNeeds = await prisma.clubOrderNeed.findMany({ where: { personId: tay }, select: { itemId: true, status: true, organizationId: true } });
  assert(tayNeeds.length === 2, `a transfer never duplicates needs, found ${tayNeeds.length}`);
  assert(tayNeeds.find((need) => need.itemId === items.cooking)?.organizationId === clubs.to, "the NEEDED need follows the member to their new club");
  assert(tayNeeds.find((need) => need.itemId === items.linked)?.organizationId === clubs.from, "the ORDERED need stays with the club that ordered it");
  console.log("ok  transfers: a NEEDED need follows the member; an ORDERED one stays with the ordering club");

  // ---------------------------------------------------------------- finding 6: Honors Weekend write-back
  const pat = await addPerson("pat", "Pat", "Handrecorded");
  const sam = await addPerson("sam", "Sam", "Weekender");
  const lee = await addPerson("lee", "Lee", "Elsewhere");
  const patMember = await addMember(clubs.weekend, pat);
  const samMember = await addMember(clubs.weekend, sam);
  const leeMember = await addMember(clubs.other, lee); // on another club's roster, enrolled through this one
  const handRecorded = await complete(pat, honors.weekend, clubs.weekend, "2026-11-01");

  await prisma.event.create({
    data: {
      id: eventId, slug: `${P}-event`, name: "Order check Honors Weekend", startsAt: new Date("2026-12-05T15:00:00Z"),
      endsAt: new Date("2026-12-06T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-10-01",
      registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: pat, confirmationCode: `${P.toUpperCase()}-HW`, status: "SUBMITTED", totalAmount: 0 } });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubs.weekend, registrationId: registration.id } });
  const session = await prisma.honorSession.create({ data: { eventId, name: "Sabbath afternoon", normalizedName: "sabbath afternoon" } });
  const offering = await prisma.honorOffering.create({ data: { eventId, honorId: honors.weekend, sessionId: session.id, span: "SINGLE_SESSION", capacity: 10 } });
  const attendees: Array<[string, string, string, string]> = [[pat, patMember.id, "Pat", "Handrecorded"], [sam, samMember.id, "Sam", "Weekender"], [lee, leeMember.id, "Lee", "Elsewhere"]];
  for (const [index, [personId, memberId, firstName, lastName]] of attendees.entries()) {
    const attendee = await prisma.registrationAttendee.create({
      data: { eventId, registrationId: registration.id, personId, attendeeType: "ATTENDEE", position: index, profileSnapshot: { firstName, lastName, clubRosterMemberId: memberId } },
    });
    await prisma.honorEnrollment.create({ data: { eventId, offeringId: offering.id, registrationId: registration.id, registrationAttendeeId: attendee.id, organizationId: clubs.weekend, consumesSeat: true } });
    await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: attendee.id, idempotencyKey: `${P}-checkin-${index}` } });
  }

  // Two runs at once: no failure, and each enrollment is written back once.
  const runs = await Promise.all([writeBackHonorsWeekendCompletions(eventId, staffUserId), writeBackHonorsWeekendCompletions(eventId, staffUserId)]);
  assert(runs[0].written + runs[1].written === 1, `only Sam gets a new entry across both runs, got ${JSON.stringify(runs)}`);
  const later = runs[0].alreadyRecorded >= runs[1].alreadyRecorded ? runs[0] : runs[1];
  assert(later.alreadyRecorded === 2 && later.skipped === 1, `the later run reports 2 already recorded and Lee skipped, got ${JSON.stringify(later)}`);
  const patEntries = await prisma.memberHonorEntry.findMany({ where: { personId: pat, honorId: honors.weekend }, select: { id: true } });
  assert(patEntries.length === 1 && patEntries[0].id === handRecorded.id, "hand-recorded then written back: still exactly 1 entry for Pat");
  const patLink = await prisma.honorWeekendCompletionLink.findFirst({ where: { memberHonorEntryId: handRecorded.id }, select: { id: true } });
  assert(patLink, "Pat's enrollment is linked to the hand-recorded entry");
  assert(await prisma.memberHonorEntry.count({ where: { personId: sam, honorId: honors.weekend } }) === 1, "Sam has exactly 1 entry");
  assert(await prisma.memberHonorEntry.count({ where: { personId: lee } }) === 0, "Lee (another club's roster member) gets nothing written");
  const rerun = await writeBackHonorsWeekendCompletions(eventId, staffUserId);
  assert(rerun.written === 0 && rerun.alreadyRecorded === 2, `a third run writes nothing, got ${JSON.stringify(rerun)}`);
  console.log("ok  Honors Weekend write-back: two runs at once don't fail, write once, and never duplicate a hand-recorded completion");
  console.log("ok  write-back skips a roster member from a different club than the enrollment's");

  await syncHonorOrderNeeds(clubs.weekend);
  assert(await prisma.clubOrderNeed.count({ where: { personId: pat } }) === 1, "hand-recorded then written back: 1 need for Pat");
  const patNeed = await prisma.clubOrderNeed.findFirstOrThrow({ where: { personId: pat }, select: { id: true } });
  await markNeedsAlreadyAwarded(clubs.weekend, [patNeed.id], actor);
  await complete(pat, honors.weekend, clubs.weekend, "2026-12-05"); // a completion-date correction (append-only)
  await complete(sam, honors.weekend, clubs.weekend, "2026-12-06"); // a re-completion
  await syncHonorOrderNeeds(clubs.weekend);
  const weekendNeeds = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.weekend }, select: { personId: true, status: true } });
  assert(weekendNeeds.filter((need) => need.personId === pat).length === 1 && weekendNeeds.find((need) => need.personId === pat)?.status === "AWARDED",
    "award then a date correction: no new need, the awarded one stays awarded");
  assert(weekendNeeds.filter((need) => need.personId === sam).length === 1, "a later COMPLETED entry never creates a second need");
  console.log("ok  needs keyed on person and honor: a date correction or re-completion never creates a second need");

  // ---------------------------------------------------------------- re-review: two weekends write back the same person and honor at once
  const vic = await addPerson("vic", "Vic", "Twoweekends");
  const vicMember = await addMember(clubs.weekend, vic);
  const twoEvents = [`${P}_event_a`, `${P}_event_b`];
  for (const [index, id] of twoEvents.entries()) {
    await prisma.event.create({
      data: {
        id, slug: `${P}-event-${index}`, name: `Order check Honors Weekend ${index}`, startsAt: new Date("2026-12-05T15:00:00Z"),
        endsAt: new Date("2026-12-06T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-10-01",
        registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
      },
    });
    const reg = await prisma.registration.create({ data: { eventId: id, accountHolderPersonId: vic, confirmationCode: `${P.toUpperCase()}-HW${index}`, status: "SUBMITTED", totalAmount: 0 } });
    await prisma.clubEventRegistration.create({ data: { eventId: id, organizationId: clubs.weekend, registrationId: reg.id } });
    const period = await prisma.honorSession.create({ data: { eventId: id, name: "Sunday morning", normalizedName: "sunday morning" } });
    const cooking = await prisma.honorOffering.create({ data: { eventId: id, honorId: honors.cooking, sessionId: period.id, span: "SINGLE_SESSION", capacity: 10 } });
    const attendee = await prisma.registrationAttendee.create({
      data: { eventId: id, registrationId: reg.id, personId: vic, attendeeType: "ATTENDEE", position: 0, profileSnapshot: { firstName: "Vic", lastName: "Twoweekends", clubRosterMemberId: vicMember.id } },
    });
    await prisma.honorEnrollment.create({ data: { eventId: id, offeringId: cooking.id, registrationId: reg.id, registrationAttendeeId: attendee.id, organizationId: clubs.weekend, consumesSeat: true } });
    await prisma.checkIn.create({ data: { eventId: id, registrationAttendeeId: attendee.id, idempotencyKey: `${P}-checkin-two-${index}` } });
  }
  const crossRuns = await Promise.all(twoEvents.map((id) => writeBackHonorsWeekendCompletions(id, staffUserId)));
  const vicEntries = await prisma.memberHonorEntry.count({ where: { personId: vic, honorId: honors.cooking } });
  assert(vicEntries === 1, `two events writing back the same person and honor at once append one entry, found ${vicEntries}`);
  assert(crossRuns[0].written + crossRuns[1].written === 1 && crossRuns[0].alreadyRecorded + crossRuns[1].alreadyRecorded === 1,
    `one event writes, the other links as already recorded, got ${JSON.stringify(crossRuns)}`);
  assert(await prisma.honorWeekendCompletionLink.count({ where: { enrollment: { eventId: { in: twoEvents } } } }) === 2, "both enrollments are linked");
  console.log("ok  two Honors Weekend events writing back the same person and honor at once: 1 entry, both enrollments linked");

  // ---------------------------------------------------------------- re-review: an honor linked in the catalog after its need was recorded
  const link1 = await addPerson("link1", "Lin", "Linklater");
  const link2 = await addPerson("link2", "Lou", "Linklater");
  const link3 = await addPerson("link3", "Lex", "Linklater");
  for (const personId of [link1, link2, link3]) {
    await addMember(clubs.link, personId);
    await complete(personId, honors.late, clubs.link);
  }
  await syncHonorOrderNeeds(clubs.link);
  const beforeLink = await listOrderList(clubs.link);
  assert(beforeLink.unmatched.length === 3 && beforeLink.lines.length === 0, "with no catalog item yet, the needs are unmatched");
  await expectCode(createOrderBatch(clubs.link, {}, actor), "NOTHING_TO_ORDER", "nothing orderable before the honor is linked");
  const itemA = `${P}_item_late_a`;
  const itemB = `${P}_item_late_b`;
  await prisma.clubSupplyItem.create({ data: { id: itemA, section: "OUTDOOR_INDUSTRIES", name: "Birds (A)", normalizedName: `${P} birds a`, catalogNumber: "006601", honorId: honors.late } });
  await syncHonorOrderNeeds(clubs.link);
  const afterLink = await listOrderList(clubs.link);
  assert(afterLink.unmatched.length === 0 && afterLink.lines[0]?.item.itemId === itemA && afterLink.lines[0].needed === 3,
    `linking the honor later moves its NEEDED needs onto the item, got ${JSON.stringify(afterLink)}`);
  console.log("ok  an honor linked in the catalog after sync: its NEEDED needs pick up the item on the next sync");

  await prisma.clubSupplyItem.update({ where: { id: itemA }, data: { honorId: null } });
  await prisma.clubSupplyItem.create({ data: { id: itemB, section: "OUTDOOR_INDUSTRIES", name: "Birds (B)", normalizedName: `${P} birds b`, catalogNumber: "006602", honorId: honors.late } });
  await syncHonorOrderNeeds(clubs.link);
  const afterRelink = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.link }, select: { itemId: true } });
  assert(afterRelink.length === 3 && afterRelink.every((need) => need.itemId === itemB), "re-linking the honor to another item moves NEEDED needs to it");
  await createOrderBatch(clubs.link, {}, actor);
  await prisma.clubSupplyItem.update({ where: { id: itemB }, data: { honorId: null } });
  await prisma.clubSupplyItem.update({ where: { id: itemA }, data: { honorId: honors.late } });
  await syncHonorOrderNeeds(clubs.link);
  const orderedAfterRelink = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubs.link }, select: { itemId: true, status: true } });
  assert(orderedAfterRelink.every((need) => need.status === "ORDERED" && need.itemId === itemB), "an ORDERED need keeps the item it was ordered as");
  console.log("ok  re-linking to a different item: NEEDED needs follow it; ORDERED needs keep what was ordered");

  // ---------------------------------------------------------------- re-review: a withdrawn completion
  const wade = await addPerson("wade", "Wade", "Withdrawn");
  await addMember(clubs.link, wade);
  await complete(wade, honors.late, clubs.link);
  await syncHonorOrderNeeds(clubs.link);
  assert(await prisma.clubOrderNeed.count({ where: { personId: wade, status: "NEEDED" } }) === 1, "Wade's completion is a NEEDED need");
  const correctBack = (personId: string) => prisma.memberHonorEntry.create({
    data: { personId, honorId: honors.late, status: "IN_PROGRESS", organizationId: clubs.link, recordedByUserId: staffUserId },
  });
  await correctBack(wade);
  await correctBack(link1); // already ORDERED: must stay
  const withdrawnSync = await syncHonorOrderNeeds(clubs.link);
  assert(withdrawnSync.withdrawn === 1, `one NEEDED need withdrawn, got ${JSON.stringify(withdrawnSync)}`);
  assert(await prisma.clubOrderNeed.count({ where: { personId: wade } }) === 0, "the withdrawn completion's NEEDED need is removed");
  assert((await prisma.clubOrderNeed.findFirst({ where: { personId: link1 }, select: { status: true } }))?.status === "ORDERED", "an ORDERED need is left alone");
  const withdrawnAudit = await prisma.auditLog.findMany({ where: { action: "CLUB_ORDER_NEEDS_WITHDRAWN", metadata: { path: ["organizationId"], equals: clubs.link } }, select: { metadata: true } });
  assert(withdrawnAudit.length === 1 && (withdrawnAudit[0].metadata as { needCount: number }).needCount === 1, "the withdrawal is audited with its count");
  await complete(wade, honors.late, clubs.link, "2026-10-01");
  await syncHonorOrderNeeds(clubs.link);
  assert(await prisma.clubOrderNeed.count({ where: { personId: wade, status: "NEEDED" } }) === 1, "completing it again records the need afresh");
  console.log("ok  a completion corrected back to in progress removes its NEEDED need (audited); ORDERED needs stay");

  // ---------------------------------------------------------------- re-review: only this club year's roster counts
  const lastYear = clubYearFor(new Date(Date.now() - 366 * 24 * 60 * 60 * 1000));
  const stale = await addPerson("stale", "Sol", "Lastyear");
  await addMember(clubs.stale, stale, "ACTIVE", lastYear);
  await complete(stale, honors.linked, clubs.stale);
  await syncHonorOrderNeeds(clubs.stale);
  assert(await prisma.clubOrderNeed.count({ where: { personId: stale } }) === 0, `an ACTIVE row on last year's roster (${lastYear}) creates no need`);
  console.log("ok  sync reads this club year's roster only, like the Honors page");

  // ---------------------------------------------------------------- #566: removing a member who has order needs
  const rex = await addPerson("rex", "Rex", "Removal");
  const rexMember = await addMember(clubs.link, rex);
  await complete(rex, honors.late, clubs.link);
  await syncHonorOrderNeeds(clubs.link);
  assert(await prisma.clubOrderNeed.count({ where: { personId: rex, status: "NEEDED" } }) === 1, "Rex's completion is a NEEDED need");
  await removeRosterMember(clubs.link, rexMember.id, actor);
  assert(await prisma.clubOrderNeed.count({ where: { personId: rex } }) === 0, "removal cancels the open need");
  assert(await prisma.person.count({ where: { id: rex } }) === 0, "with nothing else attached, the Person is deleted");
  assert((await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: rexMember.id } })).status === "REMOVED", "the roster row is erased");
  const cancelAudit = await prisma.auditLog.findMany({ where: { action: "CLUB_ORDER_NEEDS_CANCELLED_ON_REMOVAL", entityId: rexMember.id }, select: { metadata: true } });
  assert(cancelAudit.length === 1 && (cancelAudit[0].metadata as { needCount: number }).needCount === 1, "the cancellation is audited with its count");

  const olga = await addPerson("olga", "Olga", "Ordered");
  const olgaMember = await addMember(clubs.link, olga);
  await complete(olga, honors.late, clubs.link);
  await syncHonorOrderNeeds(clubs.link);
  const olgaOpen = await prisma.clubOrderNeed.findFirstOrThrow({ where: { personId: olga } });
  await prisma.clubOrderNeed.create({
    data: { organizationId: clubs.link, sourceType: "HONOR", sourceId: `${olga}:${honors.cooking}`, personId: olga, itemId: items.cooking, status: "ORDERED" },
  });
  await removeRosterMember(clubs.link, olgaMember.id, actor);
  assert(await prisma.person.count({ where: { id: olga } }) === 1, "a Person with an ordered need is kept");
  assert(await prisma.clubOrderNeed.count({ where: { id: olgaOpen.id } }) === 0, "her open need is cancelled");
  assert((await prisma.clubOrderNeed.findFirstOrThrow({ where: { personId: olga } })).status === "ORDERED", "her ordered need stays as it was");
  const olgaRow = await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: olgaMember.id } });
  assert(olgaRow.status === "REMOVED" && olgaRow.personId === null, "the roster membership still ends");
  // Erasure (ADR 0005 §6): an ordered need keeps only the name; a class completion doesn't keep the Person.
  const ellaId = await addPerson("ella", "Ella", "Erased");
  await prisma.person.update({ where: { id: ellaId }, data: { normalizedEmail: "ella.erased@example.test", phone: "555-0101" } });
  const ellaMember = await addMember(clubs.link, ellaId);
  await prisma.clubOrderNeed.create({
    data: { organizationId: clubs.link, sourceType: "HONOR", sourceId: `${ellaId}:${honors.cooking}`, personId: ellaId, itemId: items.cooking, status: "RECEIVED" },
  });
  await prisma.memberClassCompletion.create({ data: { organizationId: clubs.link, personId: ellaId, classLevel: "FRIEND", completedOn: "2026-05-01" } });
  const ellaResult = await removeRosterMember(clubs.link, ellaMember.id, actor);
  const ella = await prisma.person.findUniqueOrThrow({ where: { id: ellaId } });
  assert(ellaResult.nameKept && ella.firstName === "Ella" && ella.normalizedEmail === null && ella.phone === null, "a Person kept for a received item keeps only the name");
  assert(await prisma.memberClassCompletion.count({ where: { personId: ellaId } }) === 0, "this club's class completion is deleted with the removal");

  const cleoId = await addPerson("cleo", "Cleo", "Completion");
  const cleoMember = await addMember(clubs.link, cleoId);
  await prisma.memberClassCompletion.create({ data: { organizationId: clubs.link, personId: cleoId, classLevel: "FRIEND", completedOn: "2026-05-01" } });
  await removeRosterMember(clubs.link, cleoMember.id, actor);
  assert(await prisma.person.count({ where: { id: cleoId } }) === 0, "a class completion no longer keeps the Person");
  // Sync and removal at once: no foreign-key failure, and no need left for a removed member.
  const raceIds: string[] = [];
  for (const key of ["r1", "r2", "r3"]) {
    const id = await addPerson(`race_${key}`, "Race", key);
    const member = await addMember(clubs.link, id);
    await complete(id, honors.late, clubs.link);
    raceIds.push(id);
    await Promise.all([syncHonorOrderNeeds(clubs.link), removeRosterMember(clubs.link, member.id, actor)]);
    assert(await prisma.clubOrderNeed.count({ where: { personId: id } }) === 0, `race ${key}: no need survives the removal`);
  }
  console.log("ok  removing a member cancels an open need (audited); an ordered need keeps the Person, and removal never fails on it");
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
