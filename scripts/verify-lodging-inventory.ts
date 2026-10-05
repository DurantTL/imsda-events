/**
 * Proves lodging inventory and availability (#198, slice 1) against a real
 * PostgreSQL database, where unit tests cannot:
 *
 * - the Camp Heritage and Sunnydale templates sync idempotently (a second run
 *   changes nothing, parallel runs apply once, a newer version retires a dropped
 *   unit and never deletes it), carry the recorded counts, and hold no prices or
 *   people;
 * - an event picks one property (picking again adds nothing, a different
 *   property is refused, parallel picks make one set of rows), unavailable
 *   defaults and default holds (cooks, nurse) land once;
 * - availability is computed night by night: capacity overrides, closures,
 *   holds, partial stays, an area with no fixed limit, and external hotel
 *   details that never count as inventory;
 * - holds keep reason, actor, window and history, release returns the unit,
 *   overlapping active holds are refused by the database even when five race,
 *   holds and history cannot be deleted or rewritten directly, and rows go
 *   with their event;
 * - a unit row from another property or event cannot be attached;
 * - lodging rates are optional, unset by default, change only through the
 *   finance-guarded service call, and are audited with old and new values.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:lodging
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { quoteStay, stayFit } from "@/modules/lodging/domain";
import { LodgingError, lodgingErrorStatus } from "@/modules/lodging/errors";
import {
  changeHold,
  createHold,
  getLodgingView,
  selectEventProperty,
  setEventRate,
  updateEventLayout,
  updateEventUnit,
} from "@/modules/lodging/service";
import { syncLodgingTemplates } from "@/modules/lodging/sync";
import { lodgingPropertyTemplates, type LodgingPropertySeed } from "@/modules/lodging/templates";
import { sleepsFromBeds } from "@/modules/lodging/domain";

loadEnvConfig(process.cwd());
// Local-only, before any connection exists.
assertLocalDatabase(process.env, "run this verification");

const prisma = new PrismaClient();
const P = `lodg198_${randomUUID().slice(0, 8)}`;
const userId = `${P}_user`;
const eventIds = { sunnydale: `${P}_ev_sun`, heritage: `${P}_ev_her`, race: `${P}_ev_race`, other: `${P}_ev_other` };
const scratchKey = `${P}-scratch`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function caught(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

async function expectLodgingError(promise: Promise<unknown>, code: string, message: string) {
  const error = await caught(promise);
  assert(error instanceof LodgingError && error.code === code, `${message}: expected ${code}, got ${String(error)}`);
}

async function expectDatabaseRefusal(promise: Promise<unknown>, message: string) {
  const error = await caught(promise);
  assert(error, `${message}: the database accepted it`);
}

async function cleanup() {
  await prisma.event.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: userId }, { eventId: { startsWith: `${P}_` } }] } });
  await prisma.lodgingProperty.deleteMany({ where: { key: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function createEvent(id: string) {
  await prisma.event.create({
    data: { id, slug: `${id}-slug`, name: `Lodging check ${id}`, startsAt: new Date("2027-06-15T15:00:00Z"), endsAt: new Date("2027-06-19T15:00:00Z"), timezone: "America/Chicago" },
  });
}

const sunnydaleNights = ["2027-06-15", "2027-06-16", "2027-06-17", "2027-06-18"];

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: userId, email: `${P}@lodging.example.test`, displayName: "Lodging verifier" } });

  // ---- Template sync -------------------------------------------------------
  await syncLodgingTemplates(prisma);
  const countsBefore = await tableCounts();
  const idsBefore = (await prisma.lodgingUnit.findMany({ orderBy: { key: "asc" }, select: { id: true } })).map((row) => row.id);
  const again = await syncLodgingTemplates(prisma);
  assert(again.applied.length === 0, "a second sync applies nothing");
  assert(JSON.stringify(await tableCounts()) === JSON.stringify(countsBefore), "a second sync changes no row counts");
  const idsAfter = (await prisma.lodgingUnit.findMany({ orderBy: { key: "asc" }, select: { id: true } })).map((row) => row.id);
  assert(JSON.stringify(idsBefore) === JSON.stringify(idsAfter), "a second sync keeps every unit id");

  const sunnydale = await prisma.lodgingProperty.findUniqueOrThrow({ where: { key: "sunnydale-academy" } });
  const heritage = await prisma.lodgingProperty.findUniqueOrThrow({ where: { key: "camp-heritage" } });
  const sunUnits = await prisma.lodgingUnit.findMany({ where: { propertyId: sunnydale.id }, include: { building: true, beds: true } });
  const byKey = new Map(sunUnits.map((unit) => [unit.key, unit]));
  const inBuilding = (key: string) => sunUnits.filter((unit) => unit.building.key === key);
  assert(inBuilding("boys-dorm").filter((unit) => unit.assignable).length === 37, "Boys Dorm has 37 assignable rooms");
  assert(inBuilding("girls-dorm").length === 45, "Girls Dorm has 45 rooms");
  assert(inBuilding("conference-center").length === 4, "the conference center has 4 rooms");
  assert(sunUnits.filter((unit) => unit.kind === "RV_SITE").length === 18, "Sunnydale has 18 RV sites");
  assert(byKey.get("boys-106")?.assignable === false && byKey.get("boys-107")?.assignable === false, "Boys 106 and 107 are storage");
  assert(["boys-121", "boys-210", "boys-212"].every((key) => byKey.get(key)?.defaultUnavailable === true), "Boys 121, 210 and 212 are unavailable by default");
  assert(byKey.get("boys-122")?.floor === 1 && byKey.get("boys-123")?.floor === 1, "Boys 120-123 are on the 1st floor");
  assert(["boys-314", "boys-315", "boys-316"].every((key) => byKey.get(key)?.specialUse && byKey.get(key)?.defaultCapacity === 8), "Boys 314-316 are special use, cap 8");
  assert(byKey.get("boys-302")?.bathroom === "PRIVATE", "Boys 302 has a private bath");
  assert([101, 102, 103, 104, 105, 106, 107, 108].every((n) => byKey.has(`girls-${n}`)), "Girls 1st floor is 101-108");
  assert([byKey.get("cc-01"), byKey.get("cc-02"), byKey.get("cc-1a"), byKey.get("cc-1b")].map((unit) => unit?.defaultCapacity).join() === "2,4,1,1", "conference center capacities are 2, 4, 1, 1");
  assert(byKey.get("tents-with-power")?.defaultCapacity === 4, "tents with power default to 4");
  assert(byKey.get("tent-camping")?.defaultCapacity === null, "tent camping has no fixed limit");

  const herUnits = await prisma.lodgingUnit.findMany({ where: { propertyId: heritage.id }, include: { beds: true, building: true } });
  const holdDefaults = herUnits.filter((unit) => unit.defaultHoldReason).map((unit) => unit.key).sort();
  assert(holdDefaults.join() === "lakeview-starlight,lakeview-sunset,medicine-nurses-room", "cooks and nurse rooms carry default holds");
  assert(!herUnits.some((unit) => /house/i.test(unit.name) || /house/i.test(unit.building.name)), "Camp Heritage House is not in the inventory");
  const bottomBunks = herUnits
    .filter((unit) => ["wildlife-inn", "generals-quarters", "four-seasons-cabins", "medicine-lodge"].includes(unit.building.key) && unit.key !== "medicine-nurses-room")
    .reduce((total, unit) => total + unit.beds.filter((bed) => bed.type === "QUEEN" || bed.type === "TWIN_BUNK").length, 0);
  assert(bottomBunks === 33, `the Man Camp check: 33 queens and bottom bunks in rooms with their own bathroom, got ${bottomBunks}`);
  assert(herUnits.find((unit) => unit.key === "forest-village-beaver")?.defaultCapacity === 10 && herUnits.find((unit) => unit.key === "goldfinch")?.defaultCapacity === 6, "cabin capacities are 10 and 6");
  for (const unit of [...sunUnits, ...herUnits]) {
    const expected = unit.beds.length > 0 ? sleepsFromBeds(unit.beds.map((bed) => bed.type)) : unit.defaultCapacity;
    assert(unit.defaultCapacity === expected || unit.beds.length === 0, `capacity of ${unit.key} matches its beds`);
  }

  // No prices and no people anywhere in the inventory tables.
  const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name LIKE 'Lodging%' AND (column_name ILIKE '%cents%' OR column_name ILIKE '%price%' OR column_name ILIKE '%person%' OR column_name ILIKE '%guest%' OR column_name ILIKE '%email%')`;
  assert(columns.length === 0, `inventory tables hold no price or person columns: ${JSON.stringify(columns)}`);
  assert((await prisma.eventLodgingRate.count({ where: { eventLodging: { property: { key: { in: lodgingPropertyTemplates.map((template) => template.key) } } }, eventId: { startsWith: P } } })) === 0, "no rate exists until a person sets one");

  // Versioned and concurrent sync, on a scratch template.
  const scratch = (version: number, withSecondUnit: boolean): LodgingPropertySeed => ({
    key: scratchKey,
    name: "Scratch",
    version,
    buildings: [{ key: "b", name: "B", units: [
      { key: "u1", name: "U1", kind: "ROOM", beds: ["TWIN"] },
      ...(withSecondUnit ? [{ key: "u2", name: "U2", kind: "ROOM" as const, beds: ["QUEEN" as const] }] : []),
    ] }],
  });
  const parallel = await Promise.all([1, 2, 3, 4].map(() => syncLodgingTemplates(prisma, [scratch(1, true)])));
  assert(parallel.filter((run) => run.applied.length === 1).length === 1, "parallel first syncs apply the template exactly once");
  assert((await prisma.lodgingUnit.count({ where: { property: { key: scratchKey } } })) === 2, "parallel syncs leave one row per unit");
  await syncLodgingTemplates(prisma, [scratch(2, false)]);
  const retired = await prisma.lodgingUnit.findFirstOrThrow({ where: { property: { key: scratchKey }, key: "u2" } });
  assert(retired.retiredAt !== null, "a unit a newer version drops is retired, not deleted");
  await syncLodgingTemplates(prisma, [scratch(3, true)]);
  assert((await prisma.lodgingUnit.findFirstOrThrow({ where: { id: retired.id } })).retiredAt === null, "a unit that returns is active again with the same id");

  // ---- Event: choosing a property ------------------------------------------
  for (const id of Object.values(eventIds)) await createEvent(id);
  const first = await selectEventProperty(eventIds.sunnydale, userId, { propertyKey: "sunnydale-academy" }, prisma);
  assert(first.created && first.unitsAdded === sunUnits.length, "the event gets one row per Sunnydale unit");
  const second = await selectEventProperty(eventIds.sunnydale, userId, { propertyKey: "sunnydale-academy" }, prisma);
  assert(!second.created && second.unitsAdded === 0 && second.holdsPlaced === 0, "picking the same property again adds nothing");
  await expectLodgingError(selectEventProperty(eventIds.sunnydale, userId, { propertyKey: "camp-heritage" }, prisma), "PROPERTY_ALREADY_SET", "a second property");
  await expectLodgingError(selectEventProperty(eventIds.sunnydale, userId, { propertyKey: "nowhere" }, prisma), "PROPERTY_UNKNOWN", "an unknown property");
  const raced = await Promise.all([1, 2, 3].map(() => selectEventProperty(eventIds.race, userId, { propertyKey: "camp-heritage" }, prisma)));
  assert(raced.filter((run) => run.created).length === 1, "parallel picks create one event lodging");
  assert(await prisma.eventLodgingUnit.count({ where: { eventId: eventIds.race } }) === herUnits.length, "parallel picks make one unit row each");
  assert(await prisma.eventLodgingHold.count({ where: { eventId: eventIds.race } }) === 3, "parallel picks place each default hold once");
  await selectEventProperty(eventIds.heritage, userId, { propertyKey: "camp-heritage" }, prisma);
  const heritageView = await getLodgingView(eventIds.heritage, prisma);
  const sunsetUnit = heritageView.buildings.flatMap((building) => building.units).find((unit) => unit.key === "lakeview-sunset")!;
  assert(sunsetUnit.nightStatuses.every((status) => status === "HELD"), "Lakeview Sunset is held for every night by default");
  assert(sunsetUnit.holds.length === 1 && sunsetUnit.holds[0]!.reason === "Held for the cooks" && sunsetUnit.holds[0]!.history[0]?.actorUserId === userId, "the default hold keeps its reason and actor");
  const wolf = heritageView.buildings.flatMap((building) => building.units).find((unit) => unit.key === "wildlife-inn-wolf")!;
  assert(wolf.nightStatuses.every((status) => status === "AVAILABLE") && wolf.nightCapacities.every((value) => value === 4), "Wildlife Inn Wolf sleeps 4 on every night");

  // ---- Availability, night by night ----------------------------------------
  const view = await getLodgingView(eventIds.sunnydale, prisma);
  assert(view.nights.join() === sunnydaleNights.join(), `the event offers four nights, got ${view.nights.join()}`);
  const unitView = (key: string) => view.buildings.flatMap((building) => building.units).find((unit) => unit.key === key)!;
  const rowId = (key: string) => unitView(key).eventUnitId;
  assert(unitView("boys-121").nightStatuses.every((status) => status === "UNAVAILABLE"), "Boys 121 is unavailable by default but still in the inventory");
  assert(unitView("boys-106").nightStatuses.every((status) => status === "NOT_ASSIGNABLE"), "storage is never available");
  assert(unitView("boys-101").nightCapacities.every((value) => value === 2), "a dorm room sleeps 2");
  assert(unitView("tent-camping").nightCapacities.every((value) => value === null), "tent camping has no fixed limit");

  const baseTotal = view.totalsByNight[0]!.capacity;
  await updateEventUnit(eventIds.sunnydale, rowId("boys-101"), userId, { capacityOverride: 3 }, prisma);
  let after = await getLodgingView(eventIds.sunnydale, prisma);
  assert(after.totalsByNight[0]!.capacity === baseTotal + 1, "a capacity override changes the total");
  await updateEventUnit(eventIds.sunnydale, rowId("boys-101"), userId, { capacityOverride: null }, prisma);
  after = await getLodgingView(eventIds.sunnydale, prisma);
  assert(after.totalsByNight[0]!.capacity === baseTotal, "clearing the override restores the default");
  const unitAudit = await prisma.auditLog.findFirst({ where: { eventId: eventIds.sunnydale, action: "LODGING_UNIT_UPDATED" }, orderBy: { createdAt: "asc" } });
  assert(unitAudit && JSON.stringify(unitAudit.metadata).includes('"to":3'), "an override is audited with old and new values");

  // A room closure.
  await updateEventUnit(eventIds.sunnydale, rowId("boys-103"), userId, { unavailable: true, unavailableReason: "Plumbing repair" }, prisma);
  after = await getLodgingView(eventIds.sunnydale, prisma);
  assert(after.totalsByNight[0]!.capacity === baseTotal - 2, "a closed room leaves the inventory");
  await updateEventUnit(eventIds.sunnydale, rowId("boys-103"), userId, { unavailable: false }, prisma);

  // Holds: window, history, release, partial stays.
  const room = rowId("boys-102");
  const hold = await createHold(eventIds.sunnydale, room, userId, { kind: "MAINTENANCE", reason: "Ceiling repair", firstNight: "2027-06-16", lastNight: "2027-06-17" }, prisma);
  after = await getLodgingView(eventIds.sunnydale, prisma);
  const held = after.buildings.flatMap((building) => building.units).find((unit) => unit.key === "boys-102")!;
  assert(held.nightStatuses.join() === "AVAILABLE,HELD,HELD,AVAILABLE", `the hold covers nights 2 and 3, got ${held.nightStatuses.join()}`);
  const projection = held.nightStatuses.map((status, index) => ({ night: after.nights[index]!, status, capacity: held.nightCapacities[index] ?? null, occupied: 0, available: held.nightCapacities[index] ?? null, holdIds: [] }));
  assert(stayFit(projection, "2027-06-15", "2027-06-17", 2).blockedNights.join() === "2027-06-16", "a stay across a held night is blocked on exactly that night");
  assert(stayFit(projection, "2027-06-15", "2027-06-16", 2).fits, "a one-night partial stay before the hold fits");
  assert(stayFit(projection, "2027-06-18", "2027-06-19", 2).fits, "a one-night partial stay after the hold fits");
  assert(!stayFit(projection, "2027-06-15", "2027-06-19", 2).fits, "the full stay does not fit");
  await expectLodgingError(createHold(eventIds.sunnydale, room, userId, { kind: "STAFF", reason: "Overlaps", firstNight: "2027-06-17", lastNight: "2027-06-18" }, prisma), "HOLD_OVERLAP", "an overlapping hold");
  await createHold(eventIds.sunnydale, room, userId, { kind: "STAFF", reason: "Next to it", firstNight: "2027-06-18", lastNight: "2027-06-18" }, prisma);
  await expectLodgingError(createHold(eventIds.sunnydale, room, userId, { kind: "STAFF", reason: "Too late", firstNight: "2027-06-20", lastNight: "2027-06-21" }, prisma), "WINDOW_OUTSIDE_EVENT", "a window outside the event");
  assert(await caught(createHold(eventIds.sunnydale, room, userId, { kind: "STAFF", reason: "  ", firstNight: "2027-06-15", lastNight: "2027-06-15" }, prisma)), "a hold needs a reason");
  await expectLodgingError(updateEventUnit(eventIds.other, rowId("boys-102"), userId, { unavailable: true }, prisma), "UNIT_NOT_FOUND", "a unit row of another event");
  await changeHold(eventIds.sunnydale, hold.id, userId, { action: "change_window", firstNight: "2027-06-16", lastNight: "2027-06-16" }, prisma);
  await expectLodgingError(changeHold(eventIds.sunnydale, hold.id, userId, { action: "change_window", firstNight: "2027-06-16", lastNight: "2027-06-18" }, prisma), "HOLD_OVERLAP", "widening into another hold");
  await changeHold(eventIds.sunnydale, hold.id, userId, { action: "release", reason: "Repair finished" }, prisma);
  await expectLodgingError(changeHold(eventIds.sunnydale, hold.id, userId, { action: "release", reason: "Again" }, prisma), "HOLD_RELEASED", "releasing twice");
  after = await getLodgingView(eventIds.sunnydale, prisma);
  const released = after.buildings.flatMap((building) => building.units).find((unit) => unit.key === "boys-102")!;
  assert(released.nightStatuses.slice(0, 3).every((status) => status === "AVAILABLE") && released.nightStatuses[3] === "HELD", "releasing a hold returns the unit to the inventory");
  const history = released.holds.find((entry) => entry.id === hold.id)!.history;
  assert(history.map((entry) => entry.type).join() === "CREATED,WINDOW_CHANGED,RELEASED" && history.every((entry) => entry.actorUserId === userId), "hold history keeps every change with its actor");
  assert(history[0]!.reason === "Ceiling repair" && released.holds.find((entry) => entry.id === hold.id)!.releaseReason === "Repair finished", "the reason and release reason are kept");
  await createHold(eventIds.sunnydale, room, userId, { kind: "STAFF", reason: "Reuse after release", firstNight: "2027-06-16", lastNight: "2027-06-17" }, prisma);

  // Concurrency: five racing holds on one unit, one winner.
  const raceRoom = rowId("boys-104");
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => caught(createHold(eventIds.sunnydale, raceRoom, userId, { kind: "STAFF", reason: `Race ${n}`, firstNight: "2027-06-15", lastNight: "2027-06-18" }, prisma))));
  assert(results.filter((result) => result === null).length === 1, "exactly one of five racing holds wins");
  assert(results.filter((result) => result instanceof LodgingError && result.code === "HOLD_OVERLAP").length === 4, "the other four are refused as overlapping");
  assert(await prisma.eventLodgingHold.count({ where: { eventLodgingUnitId: raceRoom, releasedAt: null } }) === 1, "one active hold remains");

  // Another event's ids answer "not found", never a change.
  const sunHold = await prisma.eventLodgingHold.findFirstOrThrow({ where: { eventLodgingUnitId: raceRoom, releasedAt: null } });
  await selectEventProperty(eventIds.heritage, userId, { propertyKey: "camp-heritage" }, prisma);
  const crossRelease = await caught(changeHold(eventIds.heritage, sunHold.id, userId, { action: "release", reason: "Cross event" }, prisma));
  assert(crossRelease instanceof LodgingError && crossRelease.code === "HOLD_NOT_FOUND" && lodgingErrorStatus(crossRelease.code) === 404, "changing another event's hold answers 404");
  const crossCreate = await caught(createHold(eventIds.heritage, raceRoom, userId, { kind: "STAFF", reason: "Cross event", firstNight: "2027-06-15", lastNight: "2027-06-15" }, prisma));
  assert(crossCreate instanceof LodgingError && crossCreate.code === "UNIT_NOT_FOUND" && lodgingErrorStatus(crossCreate.code) === 404, "placing a hold on another event's unit answers 404");
  assert((await prisma.eventLodgingHold.findUniqueOrThrow({ where: { id: sunHold.id } })).releasedAt === null, "the other event's hold is untouched");

  // The database itself refuses what the service would.
  await expectDatabaseRefusal(prisma.$executeRaw`INSERT INTO "EventLodgingHold" ("id","eventId","eventLodgingUnitId","kind","reason","firstNight","lastNight") VALUES (${`${P}_raw`}, ${eventIds.sunnydale}, ${raceRoom}, 'STAFF', 'Raw overlap', '2027-06-16', '2027-06-16')`, "a raw overlapping hold");
  const heldRow = await prisma.eventLodgingHold.findFirstOrThrow({ where: { eventLodgingUnitId: raceRoom } });
  await expectDatabaseRefusal(prisma.eventLodgingHold.delete({ where: { id: heldRow.id } }), "deleting a hold");
  const entry = await prisma.eventLodgingHoldHistory.findFirstOrThrow({ where: { holdId: heldRow.id } });
  await expectDatabaseRefusal(prisma.eventLodgingHoldHistory.delete({ where: { id: entry.id } }), "deleting hold history");
  await expectDatabaseRefusal(prisma.eventLodgingHoldHistory.update({ where: { id: entry.id }, data: { reason: "Rewritten" } }), "rewriting hold history");
  const foreignUnit = herUnits[0]!;
  const sunnydaleLodging = await prisma.eventLodging.findUniqueOrThrow({ where: { eventId: eventIds.sunnydale } });
  await expectDatabaseRefusal(prisma.eventLodgingUnit.create({ data: { eventId: eventIds.sunnydale, eventLodgingId: sunnydaleLodging.id, unitId: foreignUnit.id } }), "attaching a unit from another property");
  await expectDatabaseRefusal(prisma.eventLodgingUnit.delete({ where: { id: raceRoom } }), "deleting an event's unit row while the event exists");
  await expectDatabaseRefusal(prisma.eventLodging.delete({ where: { id: sunnydaleLodging.id } }), "deleting event lodging while the event exists");
  await expectDatabaseRefusal(prisma.eventLodgingHold.update({ where: { id: heldRow.id }, data: { reason: "Rewritten" } }), "rewriting a hold's reason");
  await expectDatabaseRefusal(prisma.eventLodgingHold.update({ where: { id: hold.id }, data: { lastNight: new Date("2027-06-18T00:00:00Z") } }), "changing a released hold");
  await expectDatabaseRefusal(prisma.eventLodging.update({ where: { id: sunnydaleLodging.id }, data: { propertyId: heritage.id } }), "moving event lodging to another property");
  await expectDatabaseRefusal(prisma.lodgingUnit.update({ where: { id: foreignUnit.id }, data: { propertyId: sunnydale.id } }), "moving a unit to another property");
  await expectDatabaseRefusal(prisma.lodgingUnit.update({ where: { id: foreignUnit.id }, data: { buildingId: sunUnits[0]!.buildingId } }), "putting a unit in another property's building");

  // External hotel details are never inventory.
  const totalsBeforeHotel = JSON.stringify((await getLodgingView(eventIds.sunnydale, prisma)).totalsByNight);
  await prisma.event.update({ where: { id: eventIds.sunnydale }, data: { hotelName: "Example Hotel", hotelPhone: "000-0000" } });
  const withHotel = await getLodgingView(eventIds.sunnydale, prisma);
  assert(JSON.stringify(withHotel.totalsByNight) === totalsBeforeHotel && !JSON.stringify(withHotel).includes("Example Hotel"), "hotel details add no inventory");

  // ---- Optional rates -------------------------------------------------------
  assert(Object.keys(withHotel.rates).length === 0, "an event starts with no rates: lodging is included or free");
  await setEventRate(eventIds.sunnydale, userId, { category: "TENT", rate: { amountCents: 1234, basis: "PER_PERSON_NIGHT", minimumNights: null } }, prisma);
  await setEventRate(eventIds.sunnydale, userId, { category: "DORM_ROOM", rate: { amountCents: 2000, basis: "PER_UNIT_NIGHT", minimumNights: 4 } }, prisma);
  const priced = await getLodgingView(eventIds.sunnydale, prisma);
  assert(quoteStay({ rates: priced.rates, category: "TENT_WITH_POWER", nights: 2, partySize: 3 }).totalCents === 1234 * 2 * 3, "a tent with power uses the tent rate");
  assert(quoteStay({ rates: priced.rates, category: "DORM_ROOM", nights: 4, partySize: 2 }).totalCents === 8000, "a dorm room is per room per night");
  assert(quoteStay({ rates: priced.rates, category: "DORM_ROOM", nights: 3, partySize: 2 }).kind === "BELOW_MINIMUM_NIGHTS", "the 4-night minimum applies");
  assert(quoteStay({ rates: priced.rates, category: "RV_SITE", nights: 3, partySize: 2 }).kind === "INCLUDED", "a category with no rate is included");
  await setEventRate(eventIds.sunnydale, userId, { category: "TENT", rate: { amountCents: 1500, basis: "PER_PERSON_NIGHT", minimumNights: null } }, prisma);
  const tentRow = await prisma.eventLodgingRate.findFirstOrThrow({ where: { eventId: eventIds.sunnydale, category: "TENT" } });
  const rateAudit = await prisma.auditLog.findMany({ where: { eventId: eventIds.sunnydale, action: "LODGING_RATE_CHANGED" }, orderBy: { createdAt: "asc" } });
  assert(rateAudit.length === 3 && JSON.stringify(rateAudit[2]!.metadata).includes('"amountCents":1234') && JSON.stringify(rateAudit[2]!.metadata).includes('"amountCents":1500'), "rate changes are audited with old and new values");
  assert(rateAudit[0]!.entityId === tentRow.id, "a new rate's audit row names the rate's own id");
  await setEventRate(eventIds.sunnydale, userId, { category: "RV_SITE", rate: null }, prisma);
  assert(await prisma.auditLog.count({ where: { eventId: eventIds.sunnydale, action: "LODGING_RATE_CHANGED" } }) === 3, "removing a rate that does not exist leaves no audit row");
  await setEventRate(eventIds.sunnydale, userId, { category: "TENT", rate: null }, prisma);
  assert(!(await getLodgingView(eventIds.sunnydale, prisma)).rates.TENT, "a rate can be removed");
  assert(await caught(setEventRate(eventIds.sunnydale, userId, { category: "TENT", rate: { amountCents: -1, basis: "PER_UNIT_NIGHT", minimumNights: null } }, prisma)), "a negative rate is refused");

  // ---- Default holds follow the event's nights ----------------------------------
  const staffWolf = (await getLodgingView(eventIds.heritage, prisma)).buildings.flatMap((building) => building.units).find((unit) => unit.key === "wildlife-inn-wolf")!;
  const staffHold = await createHold(eventIds.heritage, staffWolf.eventUnitId, userId, { kind: "STAFF", reason: "Staff-placed", firstNight: "2027-06-16", lastNight: "2027-06-16" }, prisma);
  await prisma.event.update({ where: { id: eventIds.heritage }, data: { endsAt: new Date("2027-06-21T15:00:00Z") } });
  const heritageHolds = async () => (await getLodgingView(eventIds.heritage, prisma)).buildings.flatMap((building) => building.units).flatMap((unit) => unit.holds);
  let defaultsNow = (await heritageHolds()).filter((entry) => entry.systemDefault);
  assert(defaultsNow.length === 3 && defaultsNow.every((entry) => entry.staleDefault), "after the event gets longer, every default hold is flagged as not covering it");
  assert(!(await heritageHolds()).find((entry) => entry.id === staffHold.id)!.staleDefault, "a staff-placed hold is never flagged");
  const moved = await selectEventProperty(eventIds.heritage, userId, { propertyKey: "camp-heritage" }, prisma);
  assert(moved.holdsMoved === 3 && !moved.created, "choosing the property again moves the three default holds");
  defaultsNow = (await heritageHolds()).filter((entry) => entry.systemDefault);
  assert(defaultsNow.every((entry) => entry.lastNight === "2027-06-20" && !entry.staleDefault && entry.history.map((row) => row.type).join() === "CREATED,WINDOW_CHANGED"), "default holds now cover the new nights, with a history row");
  const staffAfter = (await heritageHolds()).find((entry) => entry.id === staffHold.id)!;
  assert(staffAfter.firstNight === "2027-06-16" && staffAfter.lastNight === "2027-06-16" && staffAfter.history.length === 1, "the staff-placed hold did not move");
  // The one-click path: extend a flagged hold through the normal hold change.
  await prisma.event.update({ where: { id: eventIds.heritage }, data: { endsAt: new Date("2027-06-23T15:00:00Z") } });
  let flagged = (await heritageHolds()).filter((entry) => entry.staleDefault);
  assert(flagged.length === 3, "a further extension flags them again");
  const heritageNights = (await getLodgingView(eventIds.heritage, prisma)).nights;
  await changeHold(eventIds.heritage, flagged[0]!.id, userId, { action: "change_window", firstNight: heritageNights[0], lastNight: heritageNights[heritageNights.length - 1] }, prisma);
  flagged = (await heritageHolds()).filter((entry) => entry.staleDefault);
  assert(flagged.length === 2, "extending one flagged hold to cover the event clears its flag");
  // A window given on a re-pick is applied (and invalid ones refused), never ignored.
  const narrowed = await selectEventProperty(eventIds.heritage, userId, { propertyKey: "camp-heritage", firstNight: "2027-06-16", lastNight: "2027-06-17" }, prisma);
  assert(narrowed.holdsMoved >= 2, "the window on a re-pick is applied and the default holds follow it");
  const narrowedView = await getLodgingView(eventIds.heritage, prisma);
  assert(narrowedView.nights.join() === "2027-06-16,2027-06-17", "the re-pick window sets the nights");
  const badWindow = await caught(selectEventProperty(eventIds.heritage, userId, { propertyKey: "camp-heritage", firstNight: "2027-06-18", lastNight: "2027-06-16" }, prisma));
  assert(badWindow && (badWindow as { name?: string }).name === "ZodError", "a window ending before it starts is a validation error");
  await selectEventProperty(eventIds.heritage, userId, { propertyKey: "camp-heritage", firstNight: null, lastNight: null }, prisma);
  assert((await getLodgingView(eventIds.heritage, prisma)).nights.length === 8, "clearing the window returns to the event's own nights");

  // ---- A template change reaches a live event only by an explicit update -------
  const snapKey = `${P}-snap`;
  const snap = (version: number): LodgingPropertySeed => ({
    key: snapKey,
    name: "Snapshot check",
    version,
    buildings: [{ key: "b", name: "B", units: version === 1
      ? [
        { key: "u1", name: "U1", kind: "ROOM", beds: ["TWIN"], defaultHold: { kind: "STAFF", reason: "Held for the check" } },
        { key: "u2", name: "U2", kind: "ROOM", beds: ["TWIN"] },
        { key: "u4", name: "U4", kind: "ROOM", beds: ["TWIN"] },
      ]
      : [
        { key: "u1", name: "U1", kind: "ROOM", beds: ["QUEEN", "QUEEN"], defaultHold: { kind: "STAFF", reason: "Held for the check" } },
        { key: "u3", name: "U3", kind: "ROOM", beds: ["DOUBLE"] },
      ] }],
  });
  await syncLodgingTemplates(prisma, [snap(1)]);
  await selectEventProperty(eventIds.other, userId, { propertyKey: snapKey }, prisma);
  const snapUnits = async () => (await getLodgingView(eventIds.other, prisma)).buildings.flatMap((building) => building.units);
  const snapRow = async (key: string) => (await snapUnits()).find((unit) => unit.key === key);
  await updateEventUnit(eventIds.other, (await snapRow("u1"))!.eventUnitId, userId, { capacityOverride: 3 }, prisma);
  await createHold(eventIds.other, (await snapRow("u2"))!.eventUnitId, userId, { kind: "MAINTENANCE", reason: "Kept after retirement", firstNight: "2027-06-15", lastNight: "2027-06-15" }, prisma);
  await syncLodgingTemplates(prisma, [snap(2)]);
  let snapView = await getLodgingView(eventIds.other, prisma);
  assert(snapView.property!.templateVersion === 1 && snapView.property!.currentTemplateVersion === 2, "the event stays on version 1 while version 2 exists");
  assert((await snapRow("u1"))!.defaultCapacity === 1 && (await snapRow("u1"))!.beds === "1 twin" && !(await snapRow("u3")) && !(await snapRow("u2"))!.retired, "a newer template changes nothing for the live event");
  const layout = await updateEventLayout(eventIds.other, userId, prisma);
  assert(layout.fromVersion === 1 && layout.toVersion === 2 && layout.unitsAdded === 1 && layout.unitsChanged === 3, `the explicit update applies the new layout, got ${JSON.stringify(layout)}`);
  snapView = await getLodgingView(eventIds.other, prisma);
  assert(Number(snapView.property!.templateVersion) === 2, "the event is now on version 2");
  assert((await snapRow("u1"))!.defaultCapacity === 4 && (await snapRow("u1"))!.beds === "2 queen" && (await snapRow("u1"))!.capacityOverride === 3, "capacity and beds follow the new layout and the staff override survives");
  assert((await snapRow("u3"))!.beds === "1 double", "a unit the template added appears");
  assert((await snapRow("u2"))?.retired === true && (await snapRow("u2"))!.holds.some((entry) => entry.active), "a retired unit with an active hold stays visible, marked retired");
  assert(!(await snapRow("u4")), "a retired unit with no hold is hidden");
  const layoutAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId: eventIds.other, action: "LODGING_LAYOUT_UPDATED" } });
  assert(JSON.stringify(layoutAudit.metadata).includes('"fromVersion":1') && JSON.stringify(layoutAudit.metadata).includes('"toVersion":2') && layoutAudit.actorUserId === userId, "the layout update is audited with versions and actor");

  // ---- Cloning carries no lodging state (checked in verify-event-cloning) ------
  // ---- Rows go with their event --------------------------------------------
  await prisma.event.delete({ where: { id: eventIds.sunnydale } });
  const leftover = await Promise.all([
    prisma.eventLodging.count({ where: { eventId: eventIds.sunnydale } }),
    prisma.eventLodgingUnit.count({ where: { eventId: eventIds.sunnydale } }),
    prisma.eventLodgingHold.count({ where: { eventId: eventIds.sunnydale } }),
    prisma.eventLodgingHoldHistory.count({ where: { eventId: eventIds.sunnydale } }),
    prisma.eventLodgingRate.count({ where: { eventId: eventIds.sunnydale } }),
  ]);
  assert(leftover.every((count) => count === 0), `deleting an event removes its lodging rows, left ${leftover.join()}`);
  assert(await prisma.lodgingUnit.count({ where: { propertyId: sunnydale.id } }) === sunUnits.length, "the property inventory survives an event's deletion");

  console.log("Lodging inventory verified.");
}

async function tableCounts() {
  return Promise.all([prisma.lodgingProperty.count(), prisma.lodgingBuilding.count(), prisma.lodgingUnit.count(), prisma.lodgingBed.count()]);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await cleanup(); } catch (error) { console.error("Cleanup failed:", error instanceof Error ? error.message : error); process.exitCode = 1; }
    await prisma.$disconnect();
  });
