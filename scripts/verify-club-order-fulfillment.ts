/**
 * Proves club order fulfillment (#487) against a real PostgreSQL database:
 * syncing a club's completed honors into needs is idempotent, the order list
 * math (needed, extras, stock, to order) matches what gets ordered, placing
 * and receiving an order moves stock by the full ordered quantity, awarding
 * decrements stock and never goes below zero, the pick list carries only
 * names and honors, and the Honors Weekend write-back job is idempotent —
 * run twice, it writes the same completion only once. Uses fictitious rows
 * it creates and removes itself.
 *
 *   npm run test:club-orders
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "corder";
const clubId = `${P}_club`;
const staffUserId = `${P}_staff`;
const eventId = `${P}_event`;
const honors = { linked: `${P}_honor_linked`, unnumbered: `${P}_honor_unnumbered`, unmatched: `${P}_honor_unmatched`, weekend: `${P}_honor_weekend` };
const items = { linked: `${P}_item_linked`, unnumbered: `${P}_item_unnumbered` };
const people = { alex: `${P}_person_alex`, casey: `${P}_person_casey`, drew: `${P}_person_drew` };
const members = { alex: `${P}_member_alex`, casey: `${P}_member_casey`, drew: `${P}_member_drew` };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(error && typeof error === "object" && "code" in error && (error as { code: string }).code === code, `${message}: expected ${code}, got ${String(error)}`);
}

async function cleanup() {
  const enrollments = await prisma.honorEnrollment.findMany({ where: { eventId }, select: { id: true } });
  await prisma.honorWeekendCompletionLink.deleteMany({ where: { enrollmentId: { in: enrollments.map((row) => row.id) } } });
  await prisma.checkIn.deleteMany({ where: { eventId } });
  await prisma.honorEnrollment.deleteMany({ where: { eventId } });
  await prisma.registrationAttendee.deleteMany({ where: { eventId } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.honorOffering.deleteMany({ where: { eventId } });
  await prisma.honorSession.deleteMany({ where: { eventId } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: staffUserId }, { metadata: { path: ["organizationId"], equals: clubId } }] } });
  await prisma.clubOrderNeed.deleteMany({ where: { organizationId: clubId } });
  const batches = await prisma.clubSupplyOrderBatch.findMany({ where: { organizationId: clubId }, select: { id: true } });
  await prisma.clubSupplyOrderLine.deleteMany({ where: { batchId: { in: batches.map((row) => row.id) } } });
  await prisma.clubSupplyOrderBatch.deleteMany({ where: { organizationId: clubId } });
  await prisma.clubSupplyStock.deleteMany({ where: { organizationId: clubId } });
  await prisma.clubSupplyItem.deleteMany({ where: { id: { in: Object.values(items) } } });
  await prisma.memberHonorEntry.deleteMany({ where: { organizationId: clubId } });
  await prisma.honor.deleteMany({ where: { id: { in: Object.values(honors) } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: clubId } });
  await prisma.person.deleteMany({ where: { id: { in: Object.values(people) } } });
  await prisma.organization.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

async function addMember(personKey: keyof typeof people, memberKey: keyof typeof members, firstName: string, lastName: string) {
  await prisma.person.create({ data: { id: people[personKey], firstName, lastName } });
  return prisma.clubRosterMember.create({
    data: {
      id: members[memberKey], organizationId: clubId, clubYear: "2026-27", personId: people[personKey],
      attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", status: "ACTIVE", source: "DIRECTOR",
    },
  });
}

async function main() {
  const { syncHonorOrderNeeds } = await import("../modules/honors/order-source");
  const { writeBackHonorsWeekendCompletions } = await import("../modules/honors/weekend-completion-repository");
  const {
    createOrderBatch,
    getOrderBatch,
    listAwardableNeeds,
    listOrderBatches,
    listOrderList,
    listPickList,
    markNeedsAwarded,
    markOrderBatchReceived,
  } = await import("../modules/club-orders/repository");
  const { adventSourceOrderCsv, readableOrderCsv } = await import("../modules/club-orders/domain");
  const { parseCsvMatrix } = await import("../modules/imports/csv-parser");

  await cleanup();
  const actor = { userId: staffUserId, actAsId: `${P}_actas` };

  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Order Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.create({ data: { id: clubId, type: "CLUB", name: "Order Check Club", normalizedName: "order check club" } });
  await prisma.honor.createMany({
    data: [
      { id: honors.linked, code: `${P.toUpperCase()}-1`, name: "Camping Skills", normalizedName: "camping skills" },
      { id: honors.unnumbered, code: `${P.toUpperCase()}-2`, name: "Wilderness Living", normalizedName: "wilderness living" },
      { id: honors.unmatched, code: `${P.toUpperCase()}-3`, name: "Orienteering", normalizedName: "orienteering" },
      { id: honors.weekend, code: `${P.toUpperCase()}-4`, name: "Knot Tying", normalizedName: "knot tying" },
    ],
  });
  await prisma.clubSupplyItem.createMany({
    data: [
      { id: items.linked, section: "OUTDOOR_INDUSTRIES", name: "Camping Skills", normalizedName: "camping skills", catalogNumber: "005157", honorId: honors.linked },
      { id: items.unnumbered, section: "OUTDOOR_INDUSTRIES", name: "Wilderness Living", normalizedName: "wilderness living", catalogNumber: null, honorId: honors.unnumbered },
    ],
  });
  // Orienteering has no linked ClubSupplyItem at all: its need must come back unmatched, not silently dropped.
  await addMember("alex", "alex", "Alex", "Sample");
  await addMember("casey", "casey", "Casey", "Demo");
  await addMember("drew", "drew", "Drew", "Placeholder");
  await prisma.memberHonorEntry.createMany({
    data: [
      { personId: people.alex, honorId: honors.linked, status: "COMPLETED", completionDate: "2026-09-20", organizationId: clubId, recordedByUserId: staffUserId },
      { personId: people.casey, honorId: honors.unnumbered, status: "COMPLETED", completionDate: "2026-09-20", organizationId: clubId, recordedByUserId: staffUserId },
      { personId: people.drew, honorId: honors.unmatched, status: "COMPLETED", completionDate: "2026-09-20", organizationId: clubId, recordedByUserId: staffUserId },
    ],
  });

  // 1. Syncing is idempotent: running it twice creates the same three needs, not six.
  await syncHonorOrderNeeds(clubId);
  await syncHonorOrderNeeds(clubId);
  const needCount = await prisma.clubOrderNeed.count({ where: { organizationId: clubId } });
  assert(needCount === 3, `expected 3 needs after syncing twice, found ${needCount}`);
  console.log("ok  syncing completed honors into needs is idempotent (3 needs, not 6)");

  // 2. The order list: needed/extra/stock math, and the unmatched honor flagged separately.
  const list = await listOrderList(clubId);
  assert(list.unmatched.length === 1 && list.unmatched[0].personId === people.drew, "Orienteering (no catalog item) should come back unmatched");
  const linkedLine = list.lines.find((line) => line.item.itemId === items.linked)!;
  const unnumberedLine = list.lines.find((line) => line.item.itemId === items.unnumbered)!;
  assert(linkedLine.needed === 1 && linkedLine.toOrder === 1 && !linkedLine.missingCatalogNumber, "Camping Skills should need 1, order 1, with a catalog number");
  assert(unnumberedLine.needed === 1 && unnumberedLine.missingCatalogNumber, "Wilderness Living should be flagged for no AdventSource number");
  console.log("ok  order list: needed/extra/stock math correct, no-catalog-number item flagged, unmatched honor separate");

  // 3. Placing an order moves matched needs to ORDERED and leaves the unmatched one alone.
  const batch = await createOrderBatch(clubId, { [items.linked]: 2 }, actor);
  const orderedLine = batch.lines.find((line) => line.item.itemId === items.linked)!;
  assert(orderedLine.needed === 1 && orderedLine.extra === 2 && orderedLine.toOrder === 3, `expected needed 1 + extra 2 = 3 to order, got ${JSON.stringify(orderedLine)}`);
  const afterOrder = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubId }, select: { status: true, itemId: true } });
  assert(afterOrder.filter((need) => need.status === "ORDERED").length === 2, "the two matched needs should now be ORDERED");
  assert(afterOrder.find((need) => need.itemId === null)?.status === "NEEDED", "the unmatched need is untouched by ordering");
  console.log("ok  placing an order: extras applied, matched needs move to ORDERED, unmatched need untouched");

  // 4. Nothing left to order (only the unmatched, unorderable need remains).
  await expectCode(createOrderBatch(clubId, {}, actor), "NOTHING_TO_ORDER", "a second order with nothing pending");
  console.log("ok  placing an order with nothing to order is refused");

  // 5. The AdventSource export never carries an item with no catalog number; the readable list still shows it.
  const batchDetail = await getOrderBatch(clubId, batch.batchId);
  const adventSourceRows = parseCsvMatrix(adventSourceOrderCsv(batchDetail.lines));
  assert(adventSourceRows.length === 2 && adventSourceRows[1][0] === "005157" && adventSourceRows[1][1] === "3", `AdventSource export should have one data row for 005157 x3, got ${JSON.stringify(adventSourceRows)}`);
  const readableRows = parseCsvMatrix(readableOrderCsv(batchDetail.lines));
  assert(readableRows.length === 3, "the readable order list should include both items");
  console.log("ok  AdventSource export: two columns, one row (no catalog number excluded); readable list keeps both");

  // 6. Receiving adds the full ordered quantity (needed + extra) to stock.
  const received = await markOrderBatchReceived(clubId, batch.batchId, actor);
  assert(received.status === "RECEIVED", "the batch should be RECEIVED");
  const stockAfterReceive = await prisma.clubSupplyStock.findMany({ where: { organizationId: clubId }, select: { itemId: true, quantityOnHand: true } });
  assert(stockAfterReceive.find((row) => row.itemId === items.linked)?.quantityOnHand === 3, "Camping Skills stock should be 3 (1 needed + 2 extra)");
  assert(stockAfterReceive.find((row) => row.itemId === items.unnumbered)?.quantityOnHand === 1, "Wilderness Living stock should be 1 (1 needed, no extra)");
  await expectCode(markOrderBatchReceived(clubId, batch.batchId, actor), "ALREADY_RECEIVED", "receiving the same order twice");
  console.log("ok  receiving: full ordered quantity added to stock, and it's refused a second time");

  // 7. The pick list carries only names and the item, nothing else.
  const pickList = await listPickList(clubId, batch.batchId);
  assert(pickList.length === 2, `expected 2 pick-list entries, found ${pickList.length}`);
  for (const entry of pickList) {
    assert(Object.keys(entry).sort().join() === "firstName,itemName,lastName", `pick list entry should carry only names and the item, got ${Object.keys(entry).join()}`);
  }
  assert(pickList.some((entry) => entry.firstName === "Alex" && entry.itemName === "Camping Skills"), "Alex should be on the pick list for Camping Skills");
  console.log("ok  pick list: names and the item only, no birth date, contact, guardian, or medical field");

  const awardable = await listAwardableNeeds(clubId);
  assert(awardable.length === 2 && awardable.every((row) => Object.keys(row).sort().join() === "firstName,itemId,itemName,lastName,needId"), "awardable needs carry names, the item, and ids only");
  const history = await listOrderBatches(clubId);
  assert(history.length === 1 && history[0].status === "RECEIVED" && history[0].totalQuantity === 4, "order history shows the received order (3 + 1)");
  console.log("ok  order history and awardable list: names and items only");

  // 8. Awarding decrements stock by one per need, and never below zero.
  const receivedNeeds = await prisma.clubOrderNeed.findMany({ where: { organizationId: clubId, status: "RECEIVED" }, select: { id: true, itemId: true } });
  const linkedNeed = receivedNeeds.find((need) => need.itemId === items.linked)!;
  const unnumberedNeed = receivedNeeds.find((need) => need.itemId === items.unnumbered)!;
  const award1 = await markNeedsAwarded(clubId, [linkedNeed.id], actor);
  assert(award1.awarded === 1, "one need should be marked awarded");
  const stockAfterAward = await prisma.clubSupplyStock.findUnique({ where: { organizationId_itemId: { organizationId: clubId, itemId: items.linked } } });
  assert(stockAfterAward?.quantityOnHand === 2, `expected Camping Skills stock to drop to 2, got ${stockAfterAward?.quantityOnHand}`);
  // Already AWARDED: awarding it again is a no-op, not a second decrement.
  const award2 = await markNeedsAwarded(clubId, [linkedNeed.id], actor);
  assert(award2.awarded === 0, "re-awarding an already-awarded need should do nothing");
  const stockUnchanged = await prisma.clubSupplyStock.findUnique({ where: { organizationId_itemId: { organizationId: clubId, itemId: items.linked } } });
  assert(stockUnchanged?.quantityOnHand === 2, "stock should not drop a second time");
  // Simulate a miscounted stock row already at zero: awarding must floor, never go negative.
  await prisma.clubSupplyStock.update({ where: { organizationId_itemId: { organizationId: clubId, itemId: items.unnumbered } }, data: { quantityOnHand: 0 } });
  await markNeedsAwarded(clubId, [unnumberedNeed.id], actor);
  const flooredStock = await prisma.clubSupplyStock.findUnique({ where: { organizationId_itemId: { organizationId: clubId, itemId: items.unnumbered } } });
  assert(flooredStock?.quantityOnHand === 0, `stock should floor at 0, got ${flooredStock?.quantityOnHand}`);
  console.log("ok  awarding: decrements stock by one per need, idempotent, and never goes below zero");

  // 9. Honors Weekend write-back (#357-#360): idempotent — running it twice writes the completion once.
  await prisma.event.create({
    data: {
      id: eventId, slug: `${P}-event`, name: "Order check Honors Weekend", startsAt: new Date("2026-12-05T15:00:00Z"),
      endsAt: new Date("2026-12-06T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-10-01",
      registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: people.alex, confirmationCode: `${P.toUpperCase()}-HW`, status: "SUBMITTED", totalAmount: 0 } });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubId, registrationId: registration.id } });
  const attendee = await prisma.registrationAttendee.create({
    data: { eventId, registrationId: registration.id, personId: people.alex, attendeeType: "ATTENDEE", position: 0, profileSnapshot: { firstName: "Alex", lastName: "Sample", clubRosterMemberId: members.alex } },
  });
  const session = await prisma.honorSession.create({ data: { eventId, name: "Sabbath afternoon", normalizedName: "sabbath afternoon" } });
  const offering = await prisma.honorOffering.create({ data: { eventId, honorId: honors.weekend, sessionId: session.id, span: "SINGLE_SESSION", capacity: 10 } });
  const enrollment = await prisma.honorEnrollment.create({ data: { eventId, offeringId: offering.id, registrationId: registration.id, registrationAttendeeId: attendee.id, organizationId: clubId, consumesSeat: true } });
  await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: attendee.id, idempotencyKey: `${P}-checkin` } });

  const firstRun = await writeBackHonorsWeekendCompletions(eventId, staffUserId);
  assert(firstRun.written === 1, `expected 1 completion written, got ${firstRun.written}`);
  const entryCountAfterFirst = await prisma.memberHonorEntry.count({ where: { personId: people.alex, honorId: honors.weekend } });
  assert(entryCountAfterFirst === 1, `expected exactly 1 entry after the first run, found ${entryCountAfterFirst}`);
  const link = await prisma.honorWeekendCompletionLink.findUnique({ where: { enrollmentId: enrollment.id } });
  assert(Boolean(link), "a completion link should exist after the first run");

  const secondRun = await writeBackHonorsWeekendCompletions(eventId, staffUserId);
  assert(secondRun.written === 0, `expected 0 newly written on the second run, got ${secondRun.written}`);
  const entryCountAfterSecond = await prisma.memberHonorEntry.count({ where: { personId: people.alex, honorId: honors.weekend } });
  assert(entryCountAfterSecond === 1, `running the write-back twice must not duplicate the entry, found ${entryCountAfterSecond}`);
  console.log("ok  Honors Weekend write-back is idempotent: running it twice writes the completion exactly once");
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
