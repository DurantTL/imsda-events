/**
 * Proves lodging assignment, moves, the waitlist, the attendee display and the rooming reports (#200, slice 3)
 * against a real PostgreSQL database, where unit tests cannot:
 *
 * - capacity is enforced night by night under the unit locks plus the capacity version: racing staff for the last
 *   bed leave one winner, two people placed on different nights of one bed both fit, one person raced into two
 *   rooms ends up in one, and every assignment writer bumps the capacity version;
 * - moves, cancellations, late arrivals, early departures and transfers each append history with actor and reason,
 *   release or keep capacity as chosen, and never overwrite an earlier history row (database triggers);
 * - a room closed, held or lowered after people were placed is a conflict, never a silent change;
 * - held, unavailable and special-use rooms are refused or need confirmation;
 * - expected guests can be assigned as a group and linked to a registration later, alternate housing uses no inventory;
 * - the proposal and the CSV import preview change nothing and apply only exactly what was previewed;
 * - accessibility flags are visible only with VIEW_SENSITIVE_DATA, in the screens, the reports and the CSV;
 * - the waitlist: joined, offered once and idempotently by a staff action (one email each), expired offers cannot be
 *   accepted, an accepted offer is promoted into a room by staff, and the database refuses every other move;
 * - attendees see their approved room only after staff publish it, roommates by first name only when turned on,
 *   adults of other registrations only, and never a contact detail;
 * - a room notice is versioned and a later change makes it obsolete;
 * - nothing changes a registration's charge, and every row goes with its event.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:lodging-assignment
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import { LodgingError, type LodgingErrorCode } from "@/modules/lodging/errors";
import { lodgingReportCsv } from "@/modules/lodging/assignment-export";
import { loadAssignmentFacts } from "@/modules/lodging/assignment-facts";
import {
  applyAssignmentAction,
  applyAssignmentPlan,
  applyPlaceholderAction,
  previewAssignmentPlan,
  renameBucket,
  updateAssignmentSettings,
} from "@/modules/lodging/assignment-service";
import { getAssignmentWorkspace, getRegistrantAssignmentView, getRoomingReports } from "@/modules/lodging/assignment-view";
import { sendRoomNotice } from "@/modules/lodging/notices";
import { createLodgingRule, saveLodgingRequest, updateLodgingSettings, type Actor } from "@/modules/lodging/preferences-service";
import { getPublicLodgingOffer } from "@/modules/lodging/registration-form";
import { createHold, selectEventProperty, updateEventUnit } from "@/modules/lodging/service";
import { syncLodgingTemplates } from "@/modules/lodging/sync";
import { applyRegistrantWaitlistAction, applyWaitlistAction, getRegistrantWaitlistView, isOpenEntryViolation } from "@/modules/lodging/waitlist-service";

loadEnvConfig(process.cwd());
// Local-only, before any connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-lodging-assignment-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = `lodg200_${randomUUID().slice(0, 8)}`;
const userId = `${P}_user`;
const eventId = `${P}_ev`;
const otherEventId = `${P}_ev_other`;
const surname = `Asg${P}`;
const N = ["2027-06-15", "2027-06-16", "2027-06-17", "2027-06-18"] as const;
const staffSensitive = { canSeeSensitive: true };
const staffBlind = { canSeeSensitive: false };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function caught(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

async function expectLodgingError(promise: Promise<unknown>, code: LodgingErrorCode, message: string) {
  const error = await caught(promise);
  assert(error instanceof LodgingError && error.code === code, `${message}: expected ${code}, got ${error instanceof LodgingError ? error.code : String(error)}`);
  return error as LodgingError;
}

async function expectDatabaseRefusal(promise: Promise<unknown>, message: string) {
  const error = await caught(promise);
  assert(error, `${message}: the database accepted it`);
}

async function cleanup() {
  const registrationIds = (await prisma.registration.findMany({ where: { eventId: { startsWith: `${P}_` } }, select: { id: true } })).map((row) => row.id);
  await prisma.messageOutbox.deleteMany({ where: { OR: [{ registrationId: { in: registrationIds } }, { eventId: { startsWith: `${P}_` } }] } });
  await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`,
    prisma.eventLodgingAssignmentNotice.deleteMany({ where: { eventId: { startsWith: `${P}_` } } }),
    prisma.eventLodgingWaitlistHistory.deleteMany({ where: { eventId: { startsWith: `${P}_` } } }),
    prisma.eventLodgingWaitlistEntry.deleteMany({ where: { eventId: { startsWith: `${P}_` } } }),
    prisma.eventLodgingAssignmentHistory.deleteMany({ where: { eventId: { startsWith: `${P}_` } } }),
    prisma.eventLodgingAssignment.deleteMany({ where: { eventId: { startsWith: `${P}_` } } }),
    prisma.eventLodgingPlaceholder.deleteMany({ where: { eventId: { startsWith: `${P}_` } } }),
  ]);
  await prisma.event.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { lastName: { startsWith: surname } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: userId }, { eventId: { startsWith: `${P}_` } }] } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function createEvent(id: string, extra: Record<string, unknown> = {}) {
  await prisma.event.create({
    data: {
      id, slug: `${id}-slug`, name: `Lodging assignment check ${id}`,
      startsAt: new Date("2027-06-15T15:00:00Z"), endsAt: new Date("2027-06-19T15:00:00Z"), timezone: "America/Chicago",
      registrationClosesOn: "2027-06-01", attendeeEditPolicy: "TIERED", isPublished: true, ...extra,
    },
  });
}

type Person = { attendeeId: string; personId: string; name: string; first: string; last: string; email: string; phone: string };
type Reg = { id: string; code: string; people: Person[]; total: string };
let counter = 0;

/** A registration with `ages.length` attendees (an age of 0 or less leaves the age unanswered). */
async function makeReg(forEvent: string, ages: number[] = [40], status: "CONFIRMED" | "CANCELLED" | "WAITLISTED" = "CONFIRMED"): Promise<Reg> {
  counter += 1;
  const people: Person[] = [];
  const created: Array<{ personId: string; first: string; last: string; email: string; phone: string }> = [];
  for (const [index] of ages.entries()) {
    const first = `Alder${counter}x${index}`;
    const last = `${surname}${counter}`;
    const person = await prisma.person.create({ data: { firstName: first, lastName: last, normalizedEmail: `${P}.${counter}.${index}@lodging.example.test`, phone: `555-02${String(counter).padStart(2, "0")}` } });
    created.push({ personId: person.id, first, last, email: person.normalizedEmail!, phone: person.phone! });
  }
  const code = `ASG-${P.slice(-6).toUpperCase()}${counter}`;
  const registration = await prisma.registration.create({
    data: { eventId: forEvent, accountHolderPersonId: created[0]!.personId, confirmationCode: code, status, totalAmount: 0, submittedAt: new Date("2027-05-20T12:00:00Z") },
  });
  for (const [index, person] of created.entries()) {
    const age = ages[index]!;
    const attendee = await prisma.registrationAttendee.create({
      data: {
        eventId: forEvent, registrationId: registration.id, personId: person.personId, attendeeType: "adult", position: index,
        profileSnapshot: { firstName: person.first, lastName: person.last }, formResponses: age > 0 ? { attendee_age: age } : {},
      },
    });
    people.push({ attendeeId: attendee.id, personId: person.personId, name: `${person.first} ${person.last}`, first: person.first, last: person.last, email: person.email, phone: person.phone });
  }
  return { id: registration.id, code, people, total: registration.totalAmount.toString() };
}

const unitRow = async (forEvent: string, key: string) => prisma.eventLodgingUnit.findFirstOrThrow({ where: { eventId: forEvent, unit: { key } }, include: { unit: true } });

const attendee = (person: Person) => ({ kind: "ATTENDEE" as const, id: person.attendeeId });

async function placeAt(forEvent: string, person: Person, key: string, first: string = N[0], last: string = N[3], extra: Record<string, unknown> = {}, reason?: string) {
  const row = await unitRow(forEvent, key);
  return applyAssignmentAction(forEvent, userId, {
    action: "place",
    ...(reason ? { reason } : {}),
    placements: [{ occupant: attendee(person), place: { kind: "UNIT", eventUnitId: row.id }, firstNight: first, lastNight: last, ...extra }],
  }, prisma);
}

const current = (forEvent: string, where: Record<string, unknown> = {}) => prisma.eventLodgingAssignment.findMany({ where: { eventId: forEvent, cancelledAt: null, ...where } });
const history = (assignmentIds: string[]) => prisma.eventLodgingAssignmentHistory.findMany({ where: { assignmentId: { in: assignmentIds } }, orderBy: [{ at: "asc" }, { revision: "asc" }] });
const night = (date: Date | null) => date?.toISOString().slice(0, 10);
const capacityVersion = async () => (await prisma.eventLodging.findUniqueOrThrow({ where: { eventId } })).capacityVersion;
const reports = (sensitive = true, forEvent = eventId) => getRoomingReports(forEvent, { canSeeSensitive: sensitive }, prisma);
const workspace = (sensitive = true) => getAssignmentWorkspace(eventId, { canSeeSensitive: sensitive }, prisma);
const exceptionKinds = async (sensitive = true) => (await workspace(sensitive)).exceptions.map((row) => row.kind).sort();
const regActorFor = (forEvent: string, reg: Reg, raw: unknown, now = new Date("2027-05-20T12:00:00Z")) => applyRegistrantWaitlistAction({ eventId: forEvent, registrationId: reg.id, accessTokenId: `${P}_tok_${reg.code}`, raw, now }, prisma);
const exceptionKindsFor = async (forEvent: string) => (await getAssignmentWorkspace(forEvent, { canSeeSensitive: true }, prisma)).exceptions.map((row) => row.kind);
const registrant = (reg: Reg, now?: Date) => getRegistrantAssignmentView({ eventId, registrationId: reg.id, now }, prisma);
const requestFor = (reg: Reg, raw: Record<string, unknown>) => saveLodgingRequest({ eventId, registrationId: reg.id, actor: { kind: "STAFF", userId, canSeeSensitive: true } as Actor, raw: { reason: "Seeded for the check", ...raw }, now: new Date("2027-05-20T12:00:00Z") }, prisma);

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: userId, email: `${P}@lodging.example.test`, displayName: "Lodging assignment verifier" } });
  await syncLodgingTemplates(prisma);
  await createEvent(eventId);
  await createEvent(otherEventId);
  await selectEventProperty(eventId, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await selectEventProperty(otherEventId, userId, { propertyKey: "sunnydale-academy" }, prisma);

  // ---- Buckets and the empty workspace -------------------------------------
  const buckets = await prisma.eventLodgingBucket.findMany({ where: { eventId }, orderBy: { kind: "asc" } });
  assert(buckets.length === 5 && buckets.map((bucket) => bucket.label).sort().join() === "Airbnb,Home,Hotel,Offsite,Other", "an event that chose a property has the five alternate-housing choices");
  const empty = await workspace();
  assert(empty.people.length === 0 && empty.counts.placed === 0 && empty.nights.length === 4 && empty.buildings.length >= 4, "the empty workspace lists the property's buildings and four nights");
  assert(empty.settings.showAssignmentsToAttendees === false && empty.settings.showRoommateFirstNames === false, "attendee display is off by default");

  // ---- Assignment, history, audit and the capacity version -----------------
  const alice = await makeReg(eventId, [40]);
  const totalBefore = await prisma.registration.findUniqueOrThrow({ where: { id: alice.id } });
  const paymentsBefore = await prisma.payment.count({ where: { eventId } });
  const version0 = await capacityVersion();
  const placed = await placeAt(eventId, alice.people[0]!, "girls-201");
  assert(placed.created === 1 && placed.released === 0, "a first placement creates one assignment");
  assert((await capacityVersion()) > version0, "an assignment bumps the capacity version");
  const [aliceRow] = await current(eventId, { attendeeId: alice.people[0]!.attendeeId });
  assert(aliceRow && night(aliceRow.firstNight) === N[0] && night(aliceRow.lastNight) === N[3] && aliceRow.source === "STAFF" && aliceRow.actorUserId === userId && aliceRow.revision === 1, "the assignment keeps nights, source and actor");
  const [aliceHistory] = await history([aliceRow.id]);
  assert(aliceHistory!.type === "ASSIGNED" && aliceHistory!.actorUserId === userId && aliceHistory!.reason === "Assigned by staff", "its history row says who and why");
  assert(await prisma.auditLog.count({ where: { eventId, action: "LODGING_ASSIGNMENT_PLACED" } }) === 1, "the placement is audited");
  const placedAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId, action: "LODGING_ASSIGNMENT_PLACED" } });
  assert(!JSON.stringify(placedAudit).includes(alice.people[0]!.last) && !JSON.stringify(placedAudit).includes(alice.people[0]!.first), "the audit entry carries no name");
  await expectLodgingError(placeAt(eventId, alice.people[0]!, "girls-202"), "ALREADY_ASSIGNED", "placing someone who is already placed");
  const same = await placeAt(eventId, alice.people[0]!, "girls-201");
  assert(same.created === 0 && same.unchanged === 1, "repeating the same placement changes nothing");
  assert((await prisma.registration.findUniqueOrThrow({ where: { id: alice.id } })).totalAmount.toString() === totalBefore.totalAmount.toString() && (await prisma.payment.count({ where: { eventId } })) === paymentsBefore, "assignment never changes a registration's charge or creates a payment");

  // ---- Night by night: partial stays, the last bed, and racing staff -------
  const bedPeople: Reg[] = [];
  for (let index = 0; index < 6; index += 1) bedPeople.push(await makeReg(eventId, [40]));
  const [p0, p1, p2, p3, p4, p5] = bedPeople.map((reg) => reg.people[0]!);
  const earlyBird = await placeAt(eventId, p0!, "cc-1a", N[0], N[1]);
  const lateBird = await placeAt(eventId, p1!, "cc-1a", N[2], N[3]);
  assert(earlyBird.created === 1 && lateBird.created === 1, "two people share one bed on different nights (partial stays)");
  await expectLodgingError(placeAt(eventId, p2!, "cc-1a", N[1], N[2]), "UNIT_FULL", "a stay that overlaps both");
  // Five staff race for the last bed on a night nobody holds: exactly one wins.
  const free = await unitRow(eventId, "cc-1b");
  const raced = await Promise.all([p2!, p3!, p4!, p5!, bedPeople[0]!.people[0]!].map((person) =>
    caught(applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: attendee(person), place: { kind: "UNIT", eventUnitId: free.id }, firstNight: N[1], lastNight: N[2] }] }, prisma))));
  const winners = raced.filter((result) => result === null).length;
  assert(winners === 1, `exactly one of five racing placements gets the last bed, got ${winners}`);
  assert(raced.filter((result) => result instanceof LodgingError && (result.code === "UNIT_FULL" || result.code === "ALREADY_ASSIGNED")).length === 4, `the others are refused cleanly: ${raced.map((result) => (result instanceof LodgingError ? result.code : String(result))).join()}`);
  const occupied = await current(eventId, { eventLodgingUnitId: free.id });
  assert(occupied.length === 1, "one row holds the last bed");
  // The same person raced into two rooms ends up in one.
  const solo = await makeReg(eventId, [40]);
  const [rA, rB] = await Promise.all(["girls-203", "girls-204"].map(async (key) => {
    const row = await unitRow(eventId, key);
    return caught(applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: attendee(solo.people[0]!), place: { kind: "UNIT", eventUnitId: row.id }, firstNight: N[0], lastNight: N[3] }] }, prisma));
  }));
  assert([rA, rB].filter((result) => result === null).length === 1 && [rA, rB].some((result) => result instanceof LodgingError && result.code === "ALREADY_ASSIGNED"), "one person raced into two rooms ends up in one");
  assert((await current(eventId, { attendeeId: solo.people[0]!.attendeeId })).length === 1, "and holds exactly one assignment");
  // A whole batch cannot overbook a room with itself.
  const crowd: Reg[] = [];
  for (let index = 0; index < 3; index += 1) crowd.push(await makeReg(eventId, [40]));
  const girls205 = await unitRow(eventId, "girls-205");
  await expectLodgingError(applyAssignmentAction(eventId, userId, {
    action: "place",
    placements: crowd.map((reg) => ({ occupant: attendee(reg.people[0]!), place: { kind: "UNIT", eventUnitId: girls205.id }, firstNight: N[0], lastNight: N[3] })),
  }, prisma), "UNIT_FULL", "a batch of three into a room for two");
  assert((await current(eventId, { eventLodgingUnitId: girls205.id })).length === 0, "a refused batch places nobody");
  // Database exclusion: even a writer that skipped the service cannot put one person in two places on one night.
  await expectDatabaseRefusal(prisma.eventLodgingAssignment.create({
    data: { eventId, eventLodgingUnitId: girls205.id, attendeeId: alice.people[0]!.attendeeId, firstNight: new Date(`${N[1]}T00:00:00Z`), lastNight: new Date(`${N[2]}T00:00:00Z`), source: "STAFF", revision: 1 },
  }), "a second overlapping assignment for one person");

  // ---- Held, unavailable and special-use rooms -----------------------------
  const victim = await makeReg(eventId, [40]);
  await expectLodgingError(placeAt(eventId, victim.people[0]!, "boys-210"), "UNIT_OUT_OF_SERVICE", "a room that is unavailable by default");
  await expectLodgingError(placeAt(eventId, victim.people[0]!, "boys-106"), "UNIT_OUT_OF_SERVICE", "a storage room");
  const heldRow = await unitRow(eventId, "girls-207");
  await createHold(eventId, heldRow.id, userId, { kind: "STAFF", reason: "Speaker", firstNight: N[1], lastNight: N[1] }, prisma);
  await expectLodgingError(placeAt(eventId, victim.people[0]!, heldRow.unit.key, N[0], N[2]), "UNIT_OUT_OF_SERVICE", "a stay across a night the room is held");
  assert((await placeAt(eventId, victim.people[0]!, heldRow.unit.key, N[2], N[3])).created === 1, "a stay on the nights around the hold is fine");
  await expectLodgingError(placeAt(eventId, (await makeReg(eventId, [40])).people[0]!, "boys-314"), "SPECIAL_USE_UNCONFIRMED", "a special-use room");
  const specialGuest = (await makeReg(eventId, [40])).people[0]!;
  assert((await placeAt(eventId, specialGuest, "boys-314", N[0], N[3], { confirmSpecialUse: true })).created === 1, "a special-use room can be used once the staff member confirms");

  // ---- Moves keep history and follow the capacity night by night -----------
  const mover = await makeReg(eventId, [40]);
  await placeAt(eventId, mover.people[0]!, "girls-211");
  const [moverRow] = await current(eventId, { attendeeId: mover.people[0]!.attendeeId });
  await expectLodgingError(placeAt(eventId, mover.people[0]!, "girls-213", N[1], N[2], { mode: "MOVE" }), "REASON_REQUIRED", "a move without a reason");
  const moved = await placeAt(eventId, mover.people[0]!, "girls-213", N[1], N[2], { mode: "MOVE" }, "Closer to the dining hall");
  assert(moved.created === 2 && moved.released === 1, "moving the middle nights trims the old row, keeps the remainder and adds the new one");
  const moverRows = await prisma.eventLodgingAssignment.findMany({ where: { attendeeId: mover.people[0]!.attendeeId }, orderBy: { firstNight: "asc" } });
  assert(moverRows.length === 3 && moverRows.every((row) => row.cancelledAt === null), "three current rows cover the stay");
  assert(moverRows.map((row) => `${night(row.firstNight)}..${night(row.lastNight)}`).join() === `${N[0]}..${N[0]},${N[1]}..${N[2]},${N[3]}..${N[3]}`, "the nights are split exactly");
  const moverHistory = await history(moverRows.map((row) => row.id));
  assert(["ASSIGNED", "MOVED_OUT", "MOVED_IN", "SPLIT_REMAINDER"].every((type) => moverHistory.some((entry) => entry.type === type)), `the history has every step: ${moverHistory.map((entry) => entry.type).join()}`);
  const movedIn = moverHistory.find((entry) => entry.type === "MOVED_IN")!;
  assert(movedIn.reason === "Closer to the dining hall" && movedIn.actorUserId === userId && night(movedIn.previousFirstNight) === N[0] && movedIn.previousUnitId === moverRow.eventLodgingUnitId, "a move records who, why and where from");
  const room211 = await unitRow(eventId, "girls-211");
  const room213 = await unitRow(eventId, "girls-213");
  const occupancyNow = (await reports()).occupancyByUnit;
  const nightsOf = (unitId: string) => occupancyNow.find((entry) => entry.unitId === unitId)!.nights.map((entry) => entry.occupied);
  assert(nightsOf(room211.id).join() === "1,0,0,1" && nightsOf(room213.id).join() === "0,1,1,0", "the report reproduces the moved stay night by night");
  // The earlier history is never rewritten or deleted.
  await expectDatabaseRefusal(prisma.eventLodgingAssignmentHistory.update({ where: { id: moverHistory[0]!.id }, data: { reason: "Rewritten" } }), "rewriting a history row");
  await expectDatabaseRefusal(prisma.eventLodgingAssignmentHistory.delete({ where: { id: moverHistory[0]!.id } }), "deleting a history row");
  await expectDatabaseRefusal(prisma.eventLodgingAssignment.delete({ where: { id: moverRows[0]!.id } }), "deleting an assignment");
  // Every change must append its history row: a change without one cannot commit.
  await expectDatabaseRefusal(prisma.eventLodgingAssignment.update({ where: { id: moverRows[0]!.id }, data: { revision: { increment: 1 } } }), "a change with no history row");
  await expectDatabaseRefusal(prisma.eventLodgingAssignment.update({ where: { id: moverRows[0]!.id }, data: { people: 1, reason: "Quiet edit" } }), "a change that does not raise the revision");
  // A move into a full room is refused and changes nothing.
  const intruder = await makeReg(eventId, [40]);
  await placeAt(eventId, intruder.people[0]!, "cc-02", N[0], N[3]);
  const before = await current(eventId, { attendeeId: mover.people[0]!.attendeeId });
  const full1 = await makeReg(eventId, [40, 40, 40]);
  for (const person of full1.people) await placeAt(eventId, person, "cc-02", N[0], N[3]);
  await expectLodgingError(placeAt(eventId, mover.people[0]!, "cc-02", N[1], N[1], { mode: "MOVE" }, "Try"), "UNIT_FULL", "a move into a room that takes four, with four in it");
  assert((await current(eventId, { attendeeId: mover.people[0]!.attendeeId })).length === before.length, "the refused move left the stay as it was");

  // ---- Cancellation, late arrival, early departure -------------------------
  const leaver = await makeReg(eventId, [40]);
  await placeAt(eventId, leaver.people[0]!, "girls-215");
  const [leaverRow] = await current(eventId, { attendeeId: leaver.people[0]!.attendeeId });
  const room215 = await unitRow(eventId, "girls-215");
  await expectLodgingError(applyAssignmentAction(eventId, userId, { action: "stay_change", occupant: attendee(leaver.people[0]!), kind: "LATE_ARRIVAL", night: N[0], reason: "No change" }, prisma), "DATES_OUTSIDE_EVENT_NIGHTS", "a late arrival that does not shorten the stay");
  const late = await applyAssignmentAction(eventId, userId, { action: "stay_change", occupant: attendee(leaver.people[0]!), kind: "LATE_ARRIVAL", night: N[2], reason: "Flight delayed" }, prisma);
  assert(late.released === 1, "a late arrival releases the nights given up");
  assert((await reports()).occupancyByUnit.find((entry) => entry.unitId === room215.id)!.nights.map((entry) => entry.occupied).join() === "0,0,1,1", "capacity is free again on the nights before arrival");
  const early = await applyAssignmentAction(eventId, userId, { action: "stay_change", occupant: attendee(leaver.people[0]!), kind: "EARLY_DEPARTURE", night: N[2], keepCapacity: true, reason: "Leaving early, keep the room for family" }, prisma);
  assert(early.noted === 1 && early.released === 0, "an early departure can keep the nights held");
  assert((await reports()).occupancyByUnit.find((entry) => entry.unitId === room215.id)!.nights.map((entry) => entry.occupied).join() === "0,0,1,1", "kept nights still use the room");
  const leaverHistory = await history([leaverRow.id]);
  assert(leaverHistory.some((entry) => entry.type === "LATE_ARRIVAL" && !entry.preservedCapacity) && leaverHistory.some((entry) => entry.type === "EARLY_DEPARTURE" && entry.preservedCapacity), "both are in the history, one noting that the room was kept");
  await applyAssignmentAction(eventId, userId, { action: "cancel", assignmentId: leaverRow.id, firstNight: N[3], lastNight: N[3], reason: "Left a night sooner" }, prisma);
  const [trimmed] = await current(eventId, { attendeeId: leaver.people[0]!.attendeeId });
  assert(night(trimmed!.lastNight) === N[2], "cancelling a night trims the stay");
  await applyAssignmentAction(eventId, userId, { action: "cancel", assignmentId: leaverRow.id, reason: "Cancelled by the guest" }, prisma);
  assert((await current(eventId, { attendeeId: leaver.people[0]!.attendeeId })).length === 0, "cancelling the rest ends the placement");
  assert((await reports()).occupancyByUnit.find((entry) => entry.unitId === room215.id)!.nights.every((entry) => entry.occupied === 0), "the room is free on every night");
  const cancelled = await prisma.eventLodgingAssignment.findUniqueOrThrow({ where: { id: leaverRow.id } });
  assert(cancelled.cancelledAt !== null && cancelled.cancelReason?.includes("Cancelled by the guest") === true && cancelled.cancelledByUserId === userId, "the cancelled row stays, with who and why");
  await expectDatabaseRefusal(prisma.eventLodgingAssignment.update({ where: { id: leaverRow.id }, data: { revision: 99 } }), "changing a cancelled assignment");
  await expectLodgingError(applyAssignmentAction(eventId, userId, { action: "cancel", assignmentId: leaverRow.id, reason: "Again" }, prisma), "ASSIGNMENT_NOT_FOUND", "cancelling twice");
  // Cancelling someone's room never touches their registration.
  assert((await prisma.registration.findUniqueOrThrow({ where: { id: leaver.id } })).status === "CONFIRMED", "the registration is untouched");

  // ---- Transfer ------------------------------------------------------------
  const giver = await makeReg(eventId, [40]);
  const taker = await makeReg(eventId, [40]);
  await placeAt(eventId, giver.people[0]!, "girls-216");
  const [giverRow] = await current(eventId, { attendeeId: giver.people[0]!.attendeeId });
  await expectLodgingError(applyAssignmentAction(eventId, userId, { action: "transfer", assignmentId: giverRow.id, to: attendee(giver.people[0]!), reason: "Same person" }, prisma), "ALREADY_ASSIGNED", "a transfer to the same person");
  const transferred = await applyAssignmentAction(eventId, userId, { action: "transfer", assignmentId: giverRow.id, to: attendee(taker.people[0]!), reason: "Substitute attendee" }, prisma);
  assert(transferred.created === 1 && transferred.released === 1, "a transfer ends one assignment and starts another");
  const [takerRow] = await current(eventId, { attendeeId: taker.people[0]!.attendeeId });
  assert(takerRow && takerRow.eventLodgingUnitId === giverRow.eventLodgingUnitId && night(takerRow.firstNight) === N[0] && night(takerRow.lastNight) === N[3], "the new holder has the same room and nights");
  const transferHistory = await history([giverRow.id, takerRow.id]);
  assert(transferHistory.some((entry) => entry.type === "TRANSFERRED_OUT" && entry.relatedAssignmentId === takerRow.id) && transferHistory.some((entry) => entry.type === "TRANSFERRED_IN" && entry.relatedAssignmentId === giverRow.id), "both sides are in the history and point at each other");
  assert((await current(eventId, { attendeeId: giver.people[0]!.attendeeId })).length === 0, "the giver no longer holds the room");

  // ---- Room closure after assignment ---------------------------------------
  // Two separate parties (a party alone above its beds is only a warning, #803).
  const lodgerA = await makeReg(eventId, [40]);
  const lodgerB = await makeReg(eventId, [40]);
  for (const person of [...lodgerA.people, ...lodgerB.people]) await placeAt(eventId, person, "girls-218", N[0], N[3]);
  assert(!(await exceptionKinds()).includes("UNIT_OUT_OF_SERVICE") && !(await exceptionKinds()).includes("OVER_CAPACITY"), "nothing is wrong before the closure");
  const room218 = await unitRow(eventId, "girls-218");
  await updateEventUnit(eventId, room218.id, userId, { unavailable: true, unavailableReason: "Burst pipe" }, prisma);
  assert((await exceptionKinds()).includes("UNIT_OUT_OF_SERVICE"), "a room closed after assignment is a conflict");
  assert((await current(eventId, { eventLodgingUnitId: room218.id })).length === 2, "the assignments are not silently changed");
  const closedReport = await reports();
  assert(closedReport.occupancy.every((row) => row.inClosedRooms >= 2) && closedReport.occupancy.every((row) => row.occupied >= row.inClosedRooms), "occupancy by night still counts people in a room closed after they were placed, and flags them");
  const closure = (await workspace()).exceptions.find((row) => row.kind === "UNIT_OUT_OF_SERVICE" && row.unitId === room218.id)!;
  assert(closure.assignmentIds.length === 2, "the conflict drills down to the two assignments");
  await expectLodgingError(placeAt(eventId, (await makeReg(eventId, [40])).people[0]!, "girls-218"), "UNIT_OUT_OF_SERVICE", "placing into the closed room");
  await updateEventUnit(eventId, room218.id, userId, { unavailable: false }, prisma);
  await updateEventUnit(eventId, room218.id, userId, { capacityOverride: 1 }, prisma);
  assert((await exceptionKinds()).includes("OVER_CAPACITY"), "lowering a room's capacity under its occupants is a conflict");
  await updateEventUnit(eventId, room218.id, userId, { capacityOverride: null }, prisma);
  assert(!(await exceptionKinds()).some((kind) => kind === "OVER_CAPACITY" || kind === "UNIT_OUT_OF_SERVICE"), "restoring the room clears both");

  // A closure racing an assignment: whichever lands first, the result is coherent (never a silent overbooking).
  const raceRoom = await unitRow(eventId, "girls-217");
  const closer = (await makeReg(eventId, [40])).people[0]!;
  const [raceResult] = await Promise.all([caught(placeAt(eventId, closer, "girls-217")), updateEventUnit(eventId, raceRoom.id, userId, { unavailable: true, unavailableReason: "Race" }, prisma)]);
  const closerRows = await current(eventId, { attendeeId: closer.attendeeId });
  if (raceResult === null) {
    assert(closerRows.length === 1 && (await workspace()).exceptions.some((row) => row.kind === "UNIT_OUT_OF_SERVICE" && row.unitId === raceRoom.id), "the assignment landed first: the closure shows as a conflict");
  } else {
    assert(raceResult instanceof LodgingError && raceResult.code === "UNIT_OUT_OF_SERVICE" && closerRows.length === 0, "the closure landed first: the assignment was refused");
  }
  await updateEventUnit(eventId, raceRoom.id, userId, { unavailable: false }, prisma);

  // ---- Alternate housing, expected guests ----------------------------------
  const hotelBucket = buckets.find((bucket) => bucket.kind === "HOTEL")!;
  const offsite = await makeReg(eventId, [40]);
  const versionBeforeHotel = await capacityVersion();
  await applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: attendee(offsite.people[0]!), place: { kind: "BUCKET", bucketId: hotelBucket.id }, firstNight: N[0], lastNight: N[3] }] }, prisma);
  assert((await capacityVersion()) > versionBeforeHotel, "every assignment writer bumps the capacity version, alternate housing included");
  assert((await reports()).occupancy.every((row) => row.offsite >= 1), "alternate housing is counted night by night, apart from the on-site places");
  assert(!(await workspace()).exceptions.some((row) => row.kind === "UNASSIGNED" && row.title.includes(offsite.people[0]!.first)), "someone in a hotel is not listed as unplaced");
  await renameBucket(eventId, userId, { bucketId: hotelBucket.id, label: "Off-site hotel" }, prisma);
  assert((await workspace()).buckets.find((bucket) => bucket.id === hotelBucket.id)?.label === "Off-site hotel" && await prisma.auditLog.count({ where: { eventId, action: "LODGING_BUCKET_RENAMED" } }) === 1, "a housing choice can be renamed, and it is audited");
  assert(await caught(renameBucket(eventId, userId, { bucketId: hotelBucket.id, label: "  " }, prisma)), "a blank name is refused");

  const club = await applyPlaceholderAction(eventId, userId, { action: "create", displayName: "Pathfinder Club (expected)", headcount: 3, note: "Expected Sabbath" }, prisma);
  const pastor = await applyPlaceholderAction(eventId, userId, { action: "create", displayName: "Visiting Pastor (expected)", headcount: 1 }, prisma);
  const tentRow = await unitRow(eventId, "tents-with-power");
  await applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: { kind: "PLACEHOLDER", id: club.id }, place: { kind: "UNIT", eventUnitId: tentRow.id }, firstNight: N[0], lastNight: N[1] }] }, prisma);
  const clubOcc = (await reports()).occupancyByUnit.find((entry) => entry.unitId === tentRow.id)!;
  assert(clubOcc.nights[0]!.occupied === 3 && clubOcc.nights[2]!.occupied === 0, "a placeholder group counts its head count, night by night");
  await expectLodgingError(applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: { kind: "PLACEHOLDER", id: pastor.id }, place: { kind: "UNIT", eventUnitId: tentRow.id }, firstNight: N[0], lastNight: N[0] }, { occupant: attendee((await makeReg(eventId, [40])).people[0]!), place: { kind: "UNIT", eventUnitId: tentRow.id }, firstNight: N[0], lastNight: N[0] }] }, prisma), "UNIT_FULL", "the tent area (4) with a club of 3 plus two more");
  await applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: { kind: "PLACEHOLDER", id: pastor.id }, place: { kind: "UNIT", eventUnitId: (await unitRow(eventId, "boys-301")).id }, firstNight: N[0], lastNight: N[3] }] }, prisma);
  await expectLodgingError(applyPlaceholderAction(eventId, userId, { action: "archive", placeholderId: pastor.id }, prisma), "PLACEHOLDER_IN_USE", "archiving a placed expected guest");
  await expectLodgingError(applyPlaceholderAction(eventId, userId, { action: "link", placeholderId: club.id, attendeeId: alice.people[0]!.attendeeId, reason: "x" }, prisma), "PLACEHOLDER_NOT_LINKABLE", "linking a group to one person");
  const pastorReg = await makeReg(eventId, [55]);
  const linked = await applyPlaceholderAction(eventId, userId, { action: "link", placeholderId: pastor.id, attendeeId: pastorReg.people[0]!.attendeeId, reason: "Registered today" }, prisma);
  assert(linked.assignments === 1, "linking carries the placement over");
  const [pastorRow] = await current(eventId, { attendeeId: pastorReg.people[0]!.attendeeId });
  assert(pastorRow && pastorRow.placeholderId === pastor.id && (await history([pastorRow.id])).some((entry) => entry.type === "LINKED"), "the assignment now belongs to the attendee and the link is in the history");
  await expectLodgingError(placeAt(eventId, pastorReg.people[0]!, "boys-302"), "ALREADY_ASSIGNED", "the linked attendee is the same person");
  await expectLodgingError(applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: { kind: "PLACEHOLDER", id: pastor.id }, place: { kind: "UNIT", eventUnitId: (await unitRow(eventId, "boys-302")).id }, firstNight: N[0], lastNight: N[0] }] }, prisma), "PLACEHOLDER_LINKED", "placing a linked placeholder");
  await expectDatabaseRefusal(prisma.eventLodgingPlaceholder.update({ where: { id: pastor.id }, data: { displayName: "Renamed" } }), "renaming a placeholder");
  await expectDatabaseRefusal(prisma.eventLodgingPlaceholder.delete({ where: { id: pastor.id } }), "deleting a placeholder");

  // ---- Households, keep-together and keep-apart warnings --------------------
  // Boys 302 is the large-family room: four twin beds.
  const moveTo = async (person: Person, key: string, reason: string, extra: Record<string, unknown> = {}) => {
    const row = await unitRow(eventId, key);
    return applyAssignmentAction(eventId, userId, { action: "place", reason, placements: [{ occupant: attendee(person), place: { kind: "UNIT", eventUnitId: row.id }, firstNight: N[0], lastNight: N[3], mode: "MOVE", ...extra }] }, prisma);
  };
  const family = await makeReg(eventId, [40, 38, 9]);
  const stranger = await makeReg(eventId, [41]);
  await placeAt(eventId, family.people[0]!, "boys-302");
  await placeAt(eventId, family.people[1]!, "boys-205");
  assert((await exceptionKinds()).includes("SPLIT_HOUSEHOLD"), "a household split across rooms (one member still unplaced) is warned about");
  await moveTo(family.people[1]!, "boys-302", "Together");
  await placeAt(eventId, family.people[2]!, "boys-302");
  assert(!(await exceptionKinds()).includes("SPLIT_HOUSEHOLD"), "the household together clears the warning");
  await createLodgingRule(eventId, userId, { kind: "SEPARATE", personAId: family.people[0]!.personId, personBId: stranger.people[0]!.personId, reason: "Asked to be apart" }, prisma);
  await placeAt(eventId, stranger.people[0]!, "boys-203");
  assert(!(await exceptionKinds()).includes("KEEP_APART"), "keep-apart people in different rooms are fine");
  await moveTo(stranger.people[0]!, "boys-302", "Placed by mistake");
  assert((await exceptionKinds()).includes("KEEP_APART"), "keep-apart people in one room are warned about (a warning, not a refusal)");
  await moveTo(stranger.people[0]!, "boys-204", "Fixed");
  assert(!(await exceptionKinds()).includes("KEEP_APART"), "moving them apart clears it");

  // ---- Accessibility: restricted to VIEW_SENSITIVE_DATA --------------------
  const needy = await makeReg(eventId, [60]);
  await requestFor(needy, { category: "DORM_ROOM", groundFloorNeeded: true });
  await placeAt(eventId, needy.people[0]!, "boys-310"); // third floor
  const sensitiveView = await workspace(true);
  const blindView = await workspace(false);
  assert(sensitiveView.exceptions.some((row) => row.kind === "ACCESSIBILITY_UNMET"), "staff with VIEW_SENSITIVE_DATA see a ground-floor need placed upstairs");
  assert(!blindView.exceptions.some((row) => row.kind === "ACCESSIBILITY_UNMET"), "staff without it do not");
  assert(!JSON.stringify(blindView).includes("groundFloorNeeded") && !JSON.stringify(blindView).includes("accessibleRoomNeeded"), "no flag field is in the workspace for staff without access");
  assert(sensitiveView.people.find((person) => person.occupantId === needy.people[0]!.attendeeId)?.groundFloorNeeded === true, "staff with access see the flag on the person");
  const blindReports = await reports(false);
  assert(!JSON.stringify(blindReports).includes("groundFloorNeeded") && !blindReports.conflicts.some((row) => row.kind === "ACCESSIBILITY_UNMET"), "the reports hold no flag for staff without access");
  const csvBlind = lodgingReportCsv("assignments", blindReports);
  const csvSensitive = lodgingReportCsv("assignments", await reports(true));
  assert(!csvBlind.includes("Ground floor needed") && csvSensitive.includes("Ground floor needed") && csvSensitive.includes('"Yes"'), "the CSV has the accessibility columns only for staff with access");
  assert(!csvBlind.includes("@") && !csvSensitive.includes("@") && !csvSensitive.includes("555-"), "the CSV holds no email or phone");
  await applyAssignmentAction(eventId, userId, { action: "place", reason: "Needs the ground floor", placements: [{ occupant: attendee(needy.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(eventId, "boys-104")).id }, firstNight: N[0], lastNight: N[3], mode: "MOVE" }] }, prisma);
  assert(!(await exceptionKinds(true)).includes("ACCESSIBILITY_UNMET"), "a ground-level room clears it");

  // ---- Proposal: preview first, then a confirmed apply (on its own event) ----
  const proposalEventId = `${P}_ev_proposal`;
  await createEvent(proposalEventId);
  await selectEventProperty(proposalEventId, userId, { propertyKey: "sunnydale-academy" }, prisma);
  const seed = (reg: Reg, raw: Record<string, unknown>) => saveLodgingRequest({ eventId: proposalEventId, registrationId: reg.id, actor: { kind: "STAFF", userId, canSeeSensitive: true } as Actor, raw: { reason: "Seeded for the check", ...raw }, now: new Date("2027-05-20T12:00:00Z") }, prisma);
  const proposed: Reg[] = [];
  for (let index = 0; index < 4; index += 1) proposed.push(await makeReg(proposalEventId, [40]));
  const bigFamily = await makeReg(proposalEventId, [40, 38, 9]);
  const groundGuest = await makeReg(proposalEventId, [70]);
  await seed(groundGuest, { category: "DORM_ROOM", groundFloorNeeded: true });
  await seed(bigFamily, { category: "DORM_ROOM", partySize: 3 });
  for (const reg of proposed) await seed(reg, { category: "CONFERENCE_CENTER_ROOM" });
  const rowsBefore = await prisma.eventLodgingAssignment.count({ where: { eventId: proposalEventId } });
  const historyBefore = await prisma.eventLodgingAssignmentHistory.count({ where: { eventId: proposalEventId } });
  const proposeOnce = (access: { canSeeSensitive: boolean }) => previewAssignmentPlan(proposalEventId, { mode: "preview", source: "PROPOSAL" }, access, prisma);
  const preview = await proposeOnce(staffSensitive);
  assert(preview.counts.new === 8 && preview.counts.problems === 0 && preview.counts.unplaced === 0 && /^[a-f0-9]{64}$/.test(preview.fingerprint), `a proposal previews every placement it would make: ${JSON.stringify(preview.counts)}`);
  assert(await prisma.eventLodgingAssignment.count({ where: { eventId: proposalEventId } }) === rowsBefore && await prisma.eventLodgingAssignmentHistory.count({ where: { eventId: proposalEventId } }) === historyBefore, "a preview changes nothing");
  const placeOf = (reg: Reg, index = 0) => preview.rows.find((row) => row.occupantId === reg.people[index]!.attendeeId)!.place;
  assert(/^(Boys|Girls) Dorm 1\d\d$/.test(placeOf(groundGuest)), `the proposal puts the ground-floor need on the ground floor: ${placeOf(groundGuest)}`);
  assert(new Set(bigFamily.people.map((_, index) => placeOf(bigFamily, index))).size === 1 && placeOf(bigFamily) === "Boys Dorm 302", `a household of three stays together in the room that takes them: ${placeOf(bigFamily)}`);
  assert(proposed.every((reg) => placeOf(reg).startsWith("Conference center ")), "the requested type is honoured");
  assert(!preview.rows.some((row) => /314|315|316|210|212|121/.test(row.place)), "special-use and unavailable rooms are never proposed");
  const blindPreview = await proposeOnce(staffBlind);
  assert(blindPreview.counts.new === 8 && blindPreview.counts.problems === 0, "a proposal also runs for staff without access to accessibility needs");
  assert(preview.fingerprint === (await proposeOnce(staffSensitive)).fingerprint, "a proposal is deterministic");
  await expectLodgingError(applyAssignmentPlan(proposalEventId, userId, { mode: "apply", source: "PROPOSAL", fingerprint: "0".repeat(64) }, staffSensitive, prisma), "PLAN_CHANGED", "applying a fingerprint that is not what would happen");
  assert(await prisma.eventLodgingAssignment.count({ where: { eventId: proposalEventId } }) === rowsBefore, "a refused apply writes nothing");
  // Someone else changes things between preview and apply: the confirmed plan no longer applies.
  await placeAt(proposalEventId, proposed[0]!.people[0]!, "girls-108", N[0], N[0]);
  await expectLodgingError(applyAssignmentPlan(proposalEventId, userId, { mode: "apply", source: "PROPOSAL", fingerprint: preview.fingerprint }, staffSensitive, prisma), "PLAN_CHANGED", "applying a plan after someone else placed a person");
  const preview2 = await proposeOnce(staffSensitive);
  assert(preview2.counts.new === 7, "the new preview no longer includes the person who was placed meanwhile");
  const applied = await applyAssignmentPlan(proposalEventId, userId, { mode: "apply", source: "PROPOSAL", fingerprint: preview2.fingerprint }, staffSensitive, prisma);
  assert(applied.created === 7, `the apply writes exactly what was previewed (${applied.created} of 7)`);
  const proposalRows = await prisma.eventLodgingAssignment.findMany({ where: { eventId: proposalEventId, source: "PROPOSAL" } });
  assert(proposalRows.length === 7 && proposalRows.every((row) => row.reason === "Rule-assisted proposal applied by staff"), "proposal rows say where they came from");
  const afterApply = await proposeOnce(staffSensitive);
  assert(afterApply.counts.new === 0 && afterApply.counts.move === 0, "applying twice would change nothing");
  assert(await prisma.eventLodgingAssignment.count({ where: { eventId, source: "PROPOSAL" } }) === 0, "a proposal on one event never touches another");

  // ---- CSV import: preview first, then a confirmed apply -------------------------
  // CSV: the export is the import.
  const exportCsv = lodgingReportCsv("assignments", await reports(false));
  const reimport = await previewAssignmentPlan(eventId, { mode: "preview", source: "CSV_IMPORT", csv: exportCsv }, staffBlind, prisma);
  assert(reimport.counts.new === 0 && reimport.counts.move === 0 && reimport.counts.problems === 0 && reimport.counts.unchanged > 0, `re-importing the export changes nothing: ${JSON.stringify(reimport.counts)}`);
  const csvGuest = (await makeReg(eventId, [40])).people[0]!;
  const csvMover = alice.people[0]!;
  const header = "Occupant ID,Place key,First night,Last night";
  const goodCsv = `${header}\r\n${csvGuest.attendeeId},unit:girls-214,${N[0]},${N[3]}\r\n${csvMover.attendeeId},unit:girls-214,${N[0]},${N[3]}`;
  // Two people into girls-102 and Alice moves there from girls-201.
  const csvPreview = await previewAssignmentPlan(eventId, { mode: "preview", source: "CSV_IMPORT", csv: goodCsv }, staffBlind, prisma);
  assert(csvPreview.counts.new === 1 && csvPreview.counts.move === 1 && csvPreview.counts.problems === 0, `the CSV previews one new placement and one move: ${JSON.stringify(csvPreview.counts)} ${JSON.stringify(csvPreview.problems)}`);
  assert((await current(eventId, { attendeeId: csvGuest.attendeeId })).length === 0, "the CSV preview changed nothing");
  const badCsv = `${header}\r\n${csvGuest.attendeeId},unit:nope-1,${N[0]},${N[3]}\r\nnot-an-id,unit:girls-214,${N[0]},${N[3]}\r\n${csvGuest.attendeeId},unit:girls-214,${N[3]},${N[0]}`;
  const badPreview = await previewAssignmentPlan(eventId, { mode: "preview", source: "CSV_IMPORT", csv: badCsv }, staffBlind, prisma);
  assert(badPreview.counts.problems === 3, `every bad row is reported: ${JSON.stringify(badPreview.problems)}`);
  await expectLodgingError(applyAssignmentPlan(eventId, userId, { mode: "apply", source: "CSV_IMPORT", csv: badCsv, fingerprint: badPreview.fingerprint }, staffBlind, prisma), "IMPORT_HAS_PROBLEMS", "applying a file with problems");
  await expectLodgingError(applyAssignmentPlan(eventId, userId, { mode: "apply", source: "CSV_IMPORT", csv: goodCsv, fingerprint: csvPreview.fingerprint === "f".repeat(64) ? "0".repeat(64) : "f".repeat(64) }, staffBlind, prisma), "PLAN_CHANGED", "applying with a different fingerprint");
  const csvApplied = await applyAssignmentPlan(eventId, userId, { mode: "apply", source: "CSV_IMPORT", csv: goodCsv, fingerprint: csvPreview.fingerprint }, staffBlind, prisma);
  assert(csvApplied.created === 2 && csvApplied.released === 1, "the confirmed import places one person and moves another");
  assert((await current(eventId, { attendeeId: csvGuest.attendeeId })).length === 1 && (await current(eventId, { attendeeId: csvMover.attendeeId }))[0]!.source === "CSV_IMPORT", "the rows record that they came from the import");
  // A file previewed, then a colleague changes an affected assignment: the apply is refused as stale.
  const csvGuest2 = (await makeReg(eventId, [40])).people[0]!;
  const staleCsv = `${header}\r\n${csvGuest2.attendeeId},unit:girls-215,${N[0]},${N[3]}\r\n${csvMover.attendeeId},unit:girls-214,${N[0]},${N[3]}`;
  const stalePreview = await previewAssignmentPlan(eventId, { mode: "preview", source: "CSV_IMPORT", csv: staleCsv }, staffBlind, prisma);
  assert(stalePreview.counts.problems === 0 && stalePreview.counts.new === 1 && stalePreview.counts.unchanged === 1, `the second file previews one new placement and one unchanged: ${JSON.stringify(stalePreview.counts)} ${JSON.stringify(stalePreview.problems)}`);
  await applyAssignmentAction(eventId, userId, { action: "place", reason: "A colleague moved her", placements: [{ occupant: attendee(csvMover), place: { kind: "UNIT", eventUnitId: (await unitRow(eventId, "girls-216")).id }, firstNight: N[0], lastNight: N[3], mode: "MOVE" }] }, prisma);
  await expectLodgingError(applyAssignmentPlan(eventId, userId, { mode: "apply", source: "CSV_IMPORT", csv: staleCsv, fingerprint: stalePreview.fingerprint }, staffBlind, prisma), "PLAN_CHANGED", "applying an import after a colleague changed an affected assignment");
  assert((await current(eventId, { attendeeId: csvGuest2.attendeeId })).length === 0 && (await current(eventId, { attendeeId: csvMover.attendeeId }))[0]!.eventLodgingUnitId === (await unitRow(eventId, "girls-216")).id, "the stale import changed nothing and the colleague's move stands");
  await expectLodgingError(previewAssignmentPlan(eventId, { mode: "preview", source: "CSV_IMPORT", csv: "  " }, staffBlind, prisma), "IMPORT_INVALID", "an empty file");
  const noColumns = await previewAssignmentPlan(eventId, { mode: "preview", source: "CSV_IMPORT", csv: "a,b\n1,2" }, staffBlind, prisma);
  assert(noColumns.counts.problems === 1 && noColumns.problems[0]!.message.includes("Occupant ID"), "a file without the needed columns reports what is missing");
  await expectLodgingError(applyAssignmentPlan(eventId, userId, { mode: "apply", source: "CSV_IMPORT", csv: "a,b\n1,2", fingerprint: noColumns.fingerprint }, staffBlind, prisma), "IMPORT_HAS_PROBLEMS", "applying a file without the needed columns")

  // ---- Reports reproduce occupancy night by night and drill down -------------
  const lonely = await makeReg(eventId, [40]);
  const report = await reports();
  const occupancyByNightTotals = report.occupancy.map((row) => row.occupied);
  const fromRooming = N.map((value) => report.rooming.filter((group) => group.placeKey.startsWith("unit:")).reduce((total, group) => total + group.occupants.filter((entry) => entry.firstNight <= value && value <= entry.lastNight).reduce((sum, entry) => sum + entry.people, 0), 0));
  assert(occupancyByNightTotals.join() === fromRooming.join(), `occupancy by night equals the rooming list night by night (${occupancyByNightTotals.join()} vs ${fromRooming.join()})`);
  const drilled = report.occupancyByUnit.flatMap((unit) => unit.nights.filter((entry) => entry.occupied > 0).map((entry) => entry.assignmentIds.length));
  assert(drilled.length > 0 && drilled.every((count) => count > 0), "every occupied unit-night drills to its assignments");
  assert(report.keyHandoff.length > 0 && report.keyHandoff.every((row) => row.arrival < row.departure && row.people > 0), "the key hand-off inputs list each room's arrival, departure and holder");
  assert(!JSON.stringify(report).match(/@lodging\.example|555-0/), "no reports carry an email or a phone number");
  assert(report.rooming.some((group) => group.placeKey.startsWith("bucket:")), "the rooming list includes housing arranged elsewhere");
  assert(report.unassigned.length > 0 && report.unassigned.every((row) => row.kind === "UNASSIGNED") && report.unassigned.some((row) => row.title.includes(lonely.people[0]!.first)), "the unassigned report names someone who is not placed");

  // ---- Waitlist ---------------------------------------------------------------
  await updateLodgingSettings(eventId, userId, { collectsPreferences: true, fullBehavior: "WAITLIST" }, prisma);
  // Make "tents with power" a type with exactly two places, one of them taken for every night.
  await updateEventUnit(eventId, tentRow.id, userId, { capacityOverride: 5 }, prisma); // the club of 3 holds 3 on two nights
  const wa = await makeReg(eventId, [40]);
  const wb = await makeReg(eventId, [40]);
  const wc = await makeReg(eventId, [40]);
  const waitlistNow = new Date("2027-05-20T12:00:00Z");
  const staffActor = (raw: unknown, now = waitlistNow) => applyWaitlistAction(eventId, userId, raw, { now }, prisma);
  const regActor = (reg: Reg, raw: unknown, now = waitlistNow) => applyRegistrantWaitlistAction({ eventId, registrationId: reg.id, accessTokenId: `${P}_tok_${reg.code}`, raw, now }, prisma);
  const joinA = await staffActor({ action: "join", registrationId: wa.id, category: "TENT_WITH_POWER", partySize: 1, reason: "Phoned the office" });
  assert(joinA.action === "join", "staff can add a registration to the waitlist");
  await expectLodgingError(staffActor({ action: "join", registrationId: wa.id, category: "TENT_WITH_POWER", partySize: 1 }), "WAITLIST_ALREADY_OPEN", "joining twice");
  await expectLodgingError(regActor(wb, { action: "join", category: "TENT_WITH_POWER", partySize: 1 }), "CATEGORY_NOT_FULL", "a registrant joining a type that still has room");
  // Fill the type by requests so it is full, then a registrant may join.
  await updateEventUnit(eventId, tentRow.id, userId, { capacityOverride: 4 }, prisma);
  const filler = await makeReg(eventId, [40, 40, 40]);
  await requestFor(filler, { category: "TENT_WITH_POWER", partySize: 3 });
  const joinB = await regActor(wb, { action: "join", category: "TENT_WITH_POWER", partySize: 1 });
  assert(joinB.status === "JOINED", "a registrant can join the waitlist of a full type on an event set to WAITLIST");
  await prisma.event.update({ where: { id: eventId }, data: { attendeeEditPolicy: "VERIFY_EVERY_EDIT" } });
  await expectLodgingError(regActor(wc, { action: "join", category: "TENT_WITH_POWER", partySize: 1 }), "EDIT_POLICY_REQUIRES_VERIFICATION", "a registrant on a verify-every-edit event");
  await prisma.event.update({ where: { id: eventId }, data: { attendeeEditPolicy: "TIERED" } });
  await updateLodgingSettings(eventId, userId, { fullBehavior: "SHOW_FULL" }, prisma);
  await expectLodgingError(regActor(wc, { action: "join", category: "TENT_WITH_POWER", partySize: 1 }), "WAITLIST_NOT_ENABLED", "a registrant when the event only shows Full");
  await updateLodgingSettings(eventId, userId, { fullBehavior: "WAITLIST" }, prisma);
  const entryA = await prisma.eventLodgingWaitlistEntry.findFirstOrThrow({ where: { registrationId: wa.id } });
  const entryB = await prisma.eventLodgingWaitlistEntry.findFirstOrThrow({ where: { registrationId: wb.id } });
  assert(entryA.status === "JOINED" && entryA.createdVia === "STAFF" && entryB.createdVia === "REGISTRANT", "entries record how they joined");

  // Make room for exactly one more person on every night: the tent area takes 4, the club of 3 sits on two nights only
  // (the filler's request, which counted as demand, is withdrawn by cancelling that registration).
  await prisma.registration.update({ where: { id: filler.id }, data: { status: "CANCELLED" } });
  await prisma.eventLodgingAssignment.findMany({ where: { eventLodgingUnitId: tentRow.id, cancelledAt: null } });
  const outboxBefore = await prisma.messageOutbox.count({ where: { eventId, templateKey: "LODGING_WAITLIST_OFFER" } });
  const versionBeforePreview = await capacityVersion();
  const offerPreview = await staffActor({ action: "offer", entryIds: [entryA.id, entryB.id] });
  assert((await capacityVersion()) === versionBeforePreview, "an offer preview is read-only: it does not bump the capacity version");
  assert(offerPreview.action === "offer" && !offerPreview.confirmed, "an offer without confirm is a preview");
  assert((await prisma.messageOutbox.count({ where: { eventId, templateKey: "LODGING_WAITLIST_OFFER" } })) === outboxBefore, "a preview queues no email");
  if (offerPreview.action !== "offer" || offerPreview.confirmed) throw new Error("FAILED: the preview shape");
  assert(offerPreview.rows.every((row) => row.recipientMasked?.includes("***@") && !row.recipientMasked.includes(P)), "the preview shows a masked destination");
  const eligibleFirst = offerPreview.rows.filter((row) => row.eligible);
  assert(eligibleFirst.length === 1, `only one place is free, so only one entry is eligible: ${JSON.stringify(offerPreview.rows.map((row) => [row.registrationCode, row.eligible, row.reason]))}`);
  const offered = await staffActor({ action: "offer", entryIds: [entryA.id, entryB.id], confirm: true, expiresInHours: 24 });
  if (offered.action !== "offer" || !offered.confirmed) throw new Error("FAILED: the offer shape");
  assert(offered.offered.length === 1 && offered.skipped.length === 1, "one offer is made and the other is skipped for lack of room");
  const outboxAfter = await prisma.messageOutbox.findMany({ where: { eventId, templateKey: "LODGING_WAITLIST_OFFER" } });
  assert(outboxAfter.length === outboxBefore + 1, "an offer queues exactly one email");
  const offerMail = outboxAfter[0]!;
  assert(offerMail.status === "CAPTURED" && (await prisma.messageDeliveryAttempt.count({ where: { messageOutboxId: offerMail.id } })) === 1, `the offer went through the existing outbox and delivery path (status ${offerMail.status})`);
  assert((await loadAssignmentFacts(prisma, eventId)).waitlist.some((row) => row.offerMessageStatus === "CAPTURED"), "the workspace exposes the offer email's outbox status");
  assert(offerMail.bodyTextSnapshot.includes("__IMSDA_PRIVATE_MANAGE_LINK__") && !/\/manage\//.test(offerMail.bodyTextSnapshot), "the offer carries the private-link sentinel, never a stored link");
  assert(!/\$\s?\d/.test(offerMail.bodyTextSnapshot) && !/\$\s?\d/.test(offerMail.bodyHtmlSnapshot ?? ""), "the offer names no price");
  const offeredEntry = await prisma.eventLodgingWaitlistEntry.findUniqueOrThrow({ where: { id: offered.offered[0]!.entryId } });
  assert(offerMail.registrationId === offeredEntry.registrationId && offerMail.recipientKind === "REGISTRANT", "the email goes to the one registration that was offered the place");
  assert(offeredEntry.status === "OFFERED" && offeredEntry.offerNumber === 1 && offeredEntry.offerExpiresAt?.toISOString() === "2027-05-21T12:00:00.000Z", "the offer has a number and an expiry");
  const again = await staffActor({ action: "offer", entryIds: [offeredEntry.id], confirm: true, expiresInHours: 24 });
  if (again.action !== "offer" || !again.confirmed) throw new Error("FAILED: the repeat shape");
  assert(again.offered[0]!.alreadyOffered && (await prisma.messageOutbox.count({ where: { eventId, templateKey: "LODGING_WAITLIST_OFFER" } })) === outboxBefore + 1, "offering again is idempotent: the same offer, no second email");
  const skippedId = offered.skipped[0]!.entryId;
  const offeredIsA = offeredEntry.id === entryA.id;
  const heldRegistration = offeredIsA ? wa : wb;
  const waitingRegistration = offeredIsA ? wb : wa;

  // An expired offer cannot be accepted, and the expiry is recorded; a new offer is the next number.
  const lateAccept = await regActor(heldRegistration, { action: "accept" }, new Date("2027-05-21T12:00:01Z"));
  assert(lateAccept.status === "EXPIRED", "accepting after the expiry is refused as expired");
  const afterExpiry = await prisma.eventLodgingWaitlistEntry.findUniqueOrThrow({ where: { id: offeredEntry.id } });
  assert(afterExpiry.status === "EXPIRED", "the expiry is recorded");
  const expiredHistory = await prisma.eventLodgingWaitlistHistory.findMany({ where: { entryId: offeredEntry.id }, orderBy: { at: "asc" } });
  assert(expiredHistory.map((entry) => entry.status).join() === "JOINED,OFFERED,EXPIRED", `the history shows joined, offered, expired: ${expiredHistory.map((entry) => entry.status).join()}`);
  assert((await getRegistrantWaitlistView({ eventId, registrationId: heldRegistration.id, now: new Date("2027-05-21T12:00:01Z") }, prisma)).entry?.status === "EXPIRED", "the registrant sees that it expired");
  // With the first offer expired, its place is free for the other entry.
  const second = await staffActor({ action: "offer", entryIds: [skippedId], confirm: true, expiresInHours: 24 }, new Date("2027-05-21T13:00:00Z"));
  if (second.action !== "offer" || !second.confirmed) throw new Error("FAILED: the second offer shape");
  assert(second.offered.length === 1 && !second.offered[0]!.alreadyOffered, "an expired offer no longer holds its place");
  // The lapsed one is offered again later; it is offer number 2 with its own email.
  const declinedSecond = await regActor(waitingRegistration, { action: "decline" }, new Date("2027-05-21T14:00:00Z"));
  assert(declinedSecond.status === "DECLINED", "a guest can decline");
  assert((await regActor(waitingRegistration, { action: "decline" }, new Date("2027-05-21T14:05:00Z"))).replay, "declining twice returns the first answer");
  const reoffer = await staffActor({ action: "offer", entryIds: [offeredEntry.id], confirm: true, expiresInHours: 48 }, new Date("2027-05-21T15:00:00Z"));
  if (reoffer.action !== "offer" || !reoffer.confirmed) throw new Error("FAILED: the re-offer shape");
  assert(reoffer.offered[0]!.offerNumber === 2 && !reoffer.offered[0]!.alreadyOffered, "re-offering an expired entry is the next offer number");
  assert((await prisma.messageOutbox.count({ where: { eventId, templateKey: "LODGING_WAITLIST_OFFER" } })) === outboxBefore + 3, "each real offer is its own email");
  await expectLodgingError(Promise.resolve(staffActor({ action: "promote", entryId: offeredEntry.id, eventUnitId: tentRow.id, attendeeIds: [heldRegistration.people[0]!.attendeeId] })), "WAITLIST_TRANSITION_INVALID", "placing an entry that has not accepted");
  // A double click: two accepts racing for one entry leave one acceptance and one history row.
  const [acceptA, acceptB] = await Promise.all([regActor(heldRegistration, { action: "accept" }, new Date("2027-05-21T16:00:00Z")), regActor(heldRegistration, { action: "accept" }, new Date("2027-05-21T16:00:00Z"))]);
  assert(acceptA.status === "ACCEPTED" && acceptB.status === "ACCEPTED" && [acceptA.replay, acceptB.replay].filter(Boolean).length === 1, "two racing accepts: one accepts, the other gets the same answer");
  assert(await prisma.eventLodgingWaitlistHistory.count({ where: { entryId: offeredEntry.id, status: "ACCEPTED" } }) === 1, "and the history holds one acceptance");
  assert((await regActor(heldRegistration, { action: "accept" }, new Date("2027-05-21T16:01:00Z"))).replay, "accepting again later is idempotent");
  const promotion = await staffActor({ action: "promote", entryId: offeredEntry.id, eventUnitId: tentRow.id, attendeeIds: [heldRegistration.people[0]!.attendeeId] }, new Date("2027-05-21T17:00:00Z"));
  if (promotion.action !== "promote") throw new Error("FAILED: the promotion shape");
  assert(promotion.status === "PROMOTED" && promotion.assignmentIds?.length === 1 && !promotion.replay, "staff place the party after it accepts");
  const [promotedRow] = await current(eventId, { attendeeId: heldRegistration.people[0]!.attendeeId });
  assert(promotedRow && promotedRow.source === "WAITLIST" && promotedRow.eventLodgingUnitId === tentRow.id, "the placement records that it came from the waitlist");
  const replayed = await staffActor({ action: "promote", entryId: offeredEntry.id, eventUnitId: tentRow.id, attendeeIds: [heldRegistration.people[0]!.attendeeId] });
  assert(replayed.action === "promote" && replayed.replay && (await current(eventId, { attendeeId: heldRegistration.people[0]!.attendeeId })).length === 1, "promoting twice places nobody twice");
  assert((await prisma.eventLodgingWaitlistHistory.findMany({ where: { entryId: offeredEntry.id }, orderBy: { at: "asc" } })).map((entry) => entry.status).join() === "JOINED,OFFERED,EXPIRED,OFFERED,ACCEPTED,PROMOTED", "the whole lifecycle is in the history");
  await expectLodgingError(staffActor({ action: "remove", entryId: offeredEntry.id, reason: "Too late" }), "WAITLIST_TRANSITION_INVALID", "removing a placed entry");
  await staffActor({ action: "join", registrationId: wc.id, category: "TENT", partySize: 1 });
  const withdrawing = await prisma.eventLodgingWaitlistEntry.findFirstOrThrow({ where: { registrationId: wc.id } });
  const removed = await staffActor({ action: "remove", entryId: withdrawing.id, reason: "Guest withdrew" });
  assert(removed.action === "remove" && removed.status === "REMOVED", "staff can remove an entry");
  const lapsedSweep = await staffActor({ action: "expire_lapsed" });
  assert(lapsedSweep.action === "expire_lapsed", "staff can record lapsed offers");
  assert((await prisma.auditLog.count({ where: { eventId, action: { in: ["LODGING_WAITLIST_OFFERED", "LODGING_WAITLIST_JOINED", "LODGING_WAITLIST_PROMOTED", "LODGING_WAITLIST_REMOVED", "LODGING_WAITLIST_DECLINED", "LODGING_WAITLIST_ACCEPTED"] } } })) >= 8, "waitlist actions are audited");
  // The database refuses every other move.
  await expectDatabaseRefusal(prisma.eventLodgingWaitlistEntry.update({ where: { id: offeredEntry.id }, data: { status: "JOINED" } }), "moving a placed entry back");
  await expectDatabaseRefusal(prisma.eventLodgingWaitlistEntry.update({ where: { id: withdrawing.id }, data: { status: "OFFERED", offerNumber: 1, offerExpiresAt: new Date() } }), "reviving a removed entry");
  await expectDatabaseRefusal(prisma.eventLodgingWaitlistEntry.update({ where: { id: offeredEntry.id }, data: { partySize: 9 } }), "changing what an entry asked for");
  await expectDatabaseRefusal(prisma.eventLodgingWaitlistHistory.update({ where: { id: expiredHistory[0]!.id }, data: { reason: "Rewritten" } }), "rewriting waitlist history");
  await expectDatabaseRefusal(prisma.eventLodgingWaitlistHistory.delete({ where: { id: expiredHistory[0]!.id } }), "deleting waitlist history");
  await expectDatabaseRefusal(prisma.eventLodgingWaitlistEntry.delete({ where: { id: offeredEntry.id } }), "deleting an entry");
  await expectDatabaseRefusal(prisma.eventLodgingWaitlistEntry.create({ data: { eventId, registrationId: wc.id, category: "TENT", partySize: 1, createdVia: "STAFF" } }), "a waitlist entry with no history row")

  // ---- One counting rule for free space (requests, unbacked placements, live offers) -------------------
  const staffStaff = { kind: "STAFF", userId, canSeeSensitive: true } as Actor;
  const requestIn = (forEvent: string, reg: Reg, raw: Record<string, unknown>) => saveLodgingRequest({ eventId: forEvent, registrationId: reg.id, actor: staffStaff, raw: { reason: "Seeded for the check", ...raw }, now: new Date("2027-05-20T12:00:00Z") }, prisma);
  const capAEvent = `${P}_ev_capa`;
  await createEvent(capAEvent);
  await selectEventProperty(capAEvent, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await updateLodgingSettings(capAEvent, userId, { collectsPreferences: true, fullBehavior: "WAITLIST" }, prisma);
  const capATent = await unitRow(capAEvent, "tents-with-power");
  await updateEventUnit(capAEvent, capATent.id, userId, { capacityOverride: 6 }, prisma);
  const requesters: Reg[] = [];
  for (let index = 0; index < 3; index += 1) {
    const reg = await makeReg(capAEvent, [40, 40]);
    await requestIn(capAEvent, reg, { category: "TENT_WITH_POWER", partySize: 2 });
    requesters.push(reg);
  }
  const waiter = await makeReg(capAEvent, [40]);
  const capNow = new Date("2027-05-20T12:00:00Z");
  const capStaff = (raw: unknown, now = capNow) => applyWaitlistAction(capAEvent, userId, raw, { now }, prisma);
  await capStaff({ action: "join", registrationId: waiter.id, category: "TENT_WITH_POWER", partySize: 1, reason: "Phoned the office" });
  const waiterEntry = await prisma.eventLodgingWaitlistEntry.findFirstOrThrow({ where: { registrationId: waiter.id } });
  const fullPreview = await capStaff({ action: "offer", entryIds: [waiterEntry.id] });
  if (fullPreview.action !== "offer" || fullPreview.confirmed) throw new Error("FAILED: the preview shape");
  assert(!fullPreview.rows[0]!.eligible && /No place is free/.test(fullPreview.rows[0]!.reason ?? ""), `scenario A: six requests for six places and nobody placed leave no place to offer (${fullPreview.rows[0]!.reason})`);
  await expectLodgingError(regActorFor(capAEvent, waiter, { action: "join", category: "TENT_WITH_POWER", partySize: 1 }), "WAITLIST_ALREADY_OPEN", "joining twice");
  // One of the requesting registrations cancels: two places are free again, and an offer is possible.
  await prisma.registration.update({ where: { id: requesters[0]!.id }, data: { status: "CANCELLED" } });
  const freePreview = await capStaff({ action: "offer", entryIds: [waiterEntry.id] });
  assert(freePreview.action === "offer" && !freePreview.confirmed && freePreview.rows[0]!.eligible, "a cancelled request frees its places for an offer");

  // An offer whose email never reached the guest can be offered again; an accepted entry is never overwritten.
  const firstOffer = await capStaff({ action: "offer", entryIds: [waiterEntry.id], confirm: true, expiresInHours: 24 });
  assert(firstOffer.action === "offer" && firstOffer.confirmed && firstOffer.offered[0]!.offerNumber === 1, "the first offer is number 1");
  if (firstOffer.action !== "offer" || !firstOffer.confirmed) throw new Error("FAILED: the offer shape");
  await prisma.messageOutbox.update({ where: { id: firstOffer.offered[0]!.messageId! }, data: { status: "FAILED" } });
  const secondOffer = await capStaff({ action: "offer", entryIds: [waiterEntry.id], confirm: true, expiresInHours: 24 }, new Date("2027-05-20T13:00:00Z"));
  assert(secondOffer.action === "offer" && secondOffer.confirmed && secondOffer.offered[0]!.offerNumber === 2 && !secondOffer.offered[0]!.alreadyOffered, "an offer whose email failed is offered again as the next number");
  const reofferHistory = await prisma.eventLodgingWaitlistHistory.findMany({ where: { entryId: waiterEntry.id }, orderBy: { at: "asc" } });
  assert(reofferHistory.map((row) => row.status).join() === "JOINED,OFFERED,EXPIRED,OFFERED" && reofferHistory[2]!.reason === "Offered again: the offer email did not reach the guest.", `the history says why it was offered again: ${JSON.stringify(reofferHistory.map((row) => [row.status, row.reason]))}`);
  await applyRegistrantWaitlistAction({ eventId: capAEvent, registrationId: waiter.id, accessTokenId: `${P}_tok_cap`, raw: { action: "accept" }, now: new Date("2027-05-20T14:00:00Z") }, prisma);
  const afterAccept = await capStaff({ action: "offer", entryIds: [waiterEntry.id], confirm: true, expiresInHours: 24 }, new Date("2027-05-20T14:05:00Z"));
  assert(afterAccept.action === "offer" && afterAccept.confirmed && afterAccept.offered.length === 0 && afterAccept.skipped.length === 1 && /accepted/.test(afterAccept.skipped[0]!.reason), "offering an accepted entry is skipped");
  assert((await prisma.eventLodgingWaitlistEntry.findUniqueOrThrow({ where: { id: waiterEntry.id } })).status === "ACCEPTED", "an accepted entry is never overwritten by an offer");
  const versionBeforeIdle = (await prisma.eventLodging.findUniqueOrThrow({ where: { eventId: capAEvent } })).capacityVersion;
  await capStaff({ action: "offer", entryIds: [waiterEntry.id] });
  assert((await prisma.eventLodging.findUniqueOrThrow({ where: { eventId: capAEvent } })).capacityVersion === versionBeforeIdle, "a preview still does not touch the capacity version");

  // An accepted entry holds its places only while its registration is active.
  const tentRemaining = async (forEvent: string) => Object.values((await getPublicLodgingOffer(forEvent, prisma))!.categories.find((entry) => entry.category === "TENT_WITH_POWER")!.remaining);
  const withAccepted = await tentRemaining(capAEvent);
  await prisma.registration.update({ where: { id: waiter.id }, data: { status: "CANCELLED" } });
  const afterCancel = await tentRemaining(capAEvent);
  assert(withAccepted.every((value) => value === 1) && afterCancel.every((value) => value === 2), `an accepted entry of a cancelled registration frees its places (${withAccepted.join()} then ${afterCancel.join()})`);

  // The database's one-open-entry index raises the error the service maps; check the mapping against Prisma's real target.
  const duplicate = await caught(prisma.eventLodgingWaitlistEntry.create({ data: { eventId: capAEvent, registrationId: waiter.id, category: "TENT_WITH_POWER", partySize: 1, createdVia: "STAFF" } }));
  assert(duplicate && isOpenEntryViolation(duplicate), `a second open entry for a registration is recognised as the open-entry violation (${JSON.stringify((duplicate as { meta?: unknown } | undefined)?.meta)})`);
  // A batch with a live offer whose email failed next to a fresh entry: the re-offer is not counted twice.
  const capDEvent = `${P}_ev_capd`;
  await createEvent(capDEvent);
  await selectEventProperty(capDEvent, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await updateLodgingSettings(capDEvent, userId, { collectsPreferences: true, fullBehavior: "WAITLIST" }, prisma);
  await updateEventUnit(capDEvent, (await unitRow(capDEvent, "tents-with-power")).id, userId, { capacityOverride: 4 }, prisma);
  const staffD = (raw: unknown, now = capNow) => applyWaitlistAction(capDEvent, userId, raw, { now }, prisma);
  const regU = await makeReg(capDEvent, [40]);
  const regF = await makeReg(capDEvent, [40]);
  await staffD({ action: "join", registrationId: regU.id, category: "TENT_WITH_POWER", partySize: 1 });
  const entryU = await prisma.eventLodgingWaitlistEntry.findFirstOrThrow({ where: { registrationId: regU.id } });
  const offerU = await staffD({ action: "offer", entryIds: [entryU.id], confirm: true, expiresInHours: 24 });
  if (offerU.action !== "offer" || !offerU.confirmed) throw new Error("FAILED: the offer shape");
  await prisma.messageOutbox.update({ where: { id: offerU.offered[0]!.messageId! }, data: { status: "SUPPRESSED" } });
  await staffD({ action: "join", registrationId: regF.id, category: "TENT_WITH_POWER", partySize: 1 });
  const entryF = await prisma.eventLodgingWaitlistEntry.findFirstOrThrow({ where: { registrationId: regF.id } });
  const batch = await staffD({ action: "offer", entryIds: [entryU.id, entryF.id], confirm: true, expiresInHours: 24 }, new Date("2027-05-20T13:00:00Z"));
  assert(batch.action === "offer" && batch.confirmed && batch.offered.length === 2 && batch.skipped.length === 0 && batch.offered.find((row) => row.entryId === entryU.id)!.offerNumber === 2 && batch.offered.find((row) => row.entryId === entryF.id)!.offerNumber === 1 && !batch.offered.some((row) => row.alreadyOffered), "a re-offer of an undelivered offer and a fresh entry are both offered in one batch");
  assert((await tentRemaining(capDEvent)).every((value) => value === 2), `each of the two live offers holds one place, the re-offer is not counted twice (${(await tentRemaining(capDEvent)).join()})`);
  // A placement outside the request's type is still counted, and a request switched after placement keeps the room counted.
  const capCEvent = `${P}_ev_capc`;
  await createEvent(capCEvent);
  await selectEventProperty(capCEvent, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await updateLodgingSettings(capCEvent, userId, { collectsPreferences: true, fullBehavior: "WAITLIST" }, prisma);
  const capCTent = await unitRow(capCEvent, "tents-with-power");
  await updateEventUnit(capCEvent, capCTent.id, userId, { capacityOverride: 6 }, prisma);
  const dormUnit = await unitRow(capCEvent, "girls-101");
  const dormCategory = dormUnit.unit.category!;
  const dormRemaining = async () => Object.values((await getPublicLodgingOffer(capCEvent, prisma))!.categories.find((entry) => entry.category === dormCategory)!.remaining);
  const dormBefore = await dormRemaining();
  const crossMover = await makeReg(capCEvent, [40, 40]);
  await requestIn(capCEvent, crossMover, { category: "TENT_WITH_POWER", partySize: 2 });
  for (const person of crossMover.people) await applyAssignmentAction(capCEvent, userId, { action: "place", placements: [{ occupant: attendee(person), place: { kind: "UNIT", eventUnitId: dormUnit.id }, firstNight: N[0], lastNight: N[3] }] }, prisma);
  const dormAfter = await dormRemaining();
  assert(dormAfter.every((value, index) => value === (dormBefore[index] as number) - 1), "a placement outside the request's type is counted in the type they were placed in: two people in one dorm room take one room");
  assert((await tentRemaining(capCEvent)).every((value) => value === 4), "and the unchanged request still holds its places (conservative until staff update it)");
  assert((await exceptionKindsFor(capCEvent)).includes("REQUEST_CATEGORY_DIFFERS"), "staff are told the registration is placed in a different type than it asked for");
  await requestIn(capCEvent, crossMover, { category: dormCategory, partySize: 2 });
  assert((await dormRemaining()).every((value, index) => value === (dormAfter[index] as number)) && (await tentRemaining(capCEvent)).every((value) => value === 6), "switching the request after placement keeps the dorm counted once and frees the tent");
  assert(!(await exceptionKindsFor(capCEvent)).includes("REQUEST_CATEGORY_DIFFERS"), "and the difference is gone once the request matches");

  // Scenario B: an expected group placed in a type takes its places from the form; a placed person with a request counts once.
  const capBEvent = `${P}_ev_capb`;
  await createEvent(capBEvent);
  await selectEventProperty(capBEvent, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await updateLodgingSettings(capBEvent, userId, { collectsPreferences: true, fullBehavior: "WAITLIST" }, prisma);
  const capBTent = await unitRow(capBEvent, "tents-with-power");
  await updateEventUnit(capBEvent, capBTent.id, userId, { capacityOverride: 40 }, prisma);
  const remainingIn = async () => {
    const offer = await getPublicLodgingOffer(capBEvent, prisma);
    return offer!.categories.find((entry) => entry.category === "TENT_WITH_POWER")!.remaining;
  };
  assert(Object.values(await remainingIn()).every((value) => value === 40), "the form starts with all forty places");
  const group = await applyPlaceholderAction(capBEvent, userId, { action: "create", displayName: "Expected choir", headcount: 10 }, prisma);
  await applyAssignmentAction(capBEvent, userId, { action: "place", placements: [{ occupant: { kind: "PLACEHOLDER", id: group.id }, place: { kind: "UNIT", eventUnitId: capBTent.id }, firstNight: N[0], lastNight: N[3] }] }, prisma);
  assert(Object.values(await remainingIn()).every((value) => value === 30), `scenario B: a placed expected group of ten leaves thirty on the form (${JSON.stringify(await remainingIn())})`);
  const backed = await makeReg(capBEvent, [40]);
  await requestIn(capBEvent, backed, { category: "TENT_WITH_POWER", partySize: 1 });
  await applyAssignmentAction(capBEvent, userId, { action: "place", placements: [{ occupant: attendee(backed.people[0]!), place: { kind: "UNIT", eventUnitId: capBTent.id }, firstNight: N[0], lastNight: N[3] }] }, prisma);
  assert(Object.values(await remainingIn()).every((value) => value === 29), "a person who has a request and is placed is counted once");

  // ---- Rooms, not people, for a room-type category (#803) ------------------------------------------
  const roomsEvent = `${P}_ev_rooms`;
  await createEvent(roomsEvent);
  await selectEventProperty(roomsEvent, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await updateLodgingSettings(roomsEvent, userId, { collectsPreferences: true, fullBehavior: "WAITLIST" }, prisma);
  const dormUnits = await prisma.eventLodgingUnit.findMany({ where: { eventLodging: { eventId: roomsEvent }, unit: { category: "DORM_ROOM" } }, include: { unit: true } });
  const keep = new Set(["girls-101", "girls-102", "girls-103"]);
  for (const row of dormUnits) if (!keep.has(row.unit.key)) await updateEventUnit(roomsEvent, row.id, userId, { capacityOverride: 0 }, prisma);
  const roomsFree = async () => Object.values((await getPublicLodgingOffer(roomsEvent, prisma))!.categories.find((entry) => entry.category === "DORM_ROOM")!.remaining);
  assert((await roomsFree()).every((value) => value === 3), `three dorm rooms are in service and counted in rooms: ${(await roomsFree()).join()}`);
  const roomFamily = await makeReg(roomsEvent, [40, 38, 9]);
  await requestIn(roomsEvent, roomFamily, { category: "DORM_ROOM", partySize: 3, roomCount: 1 });
  assert((await roomsFree()).every((value) => value === 2), "a party of three that asked for one room takes one room, not three places");
  const familyRoom = await unitRow(roomsEvent, "girls-101");
  const placedFamily = await applyAssignmentAction(roomsEvent, userId, {
    action: "place",
    placements: roomFamily.people.map((person) => ({ occupant: attendee(person), place: { kind: "UNIT", eventUnitId: familyRoom.id }, firstNight: N[0], lastNight: N[3] })),
  }, prisma);
  assert(placedFamily.created === 3 && placedFamily.warnings?.length === 1 && placedFamily.warnings[0]!.beds === 2 && placedFamily.warnings[0]!.people === 3, `a party above the room's two beds is placed with a warning, not refused: ${JSON.stringify(placedFamily.warnings)}`);
  assert((await roomsFree()).every((value) => value === 2), "the placement is the same one room as the request: counted once");
  const roomsKinds = await exceptionKindsFor(roomsEvent);
  assert(roomsKinds.includes("EXTRA_BEDDING") && !roomsKinds.includes("OVER_CAPACITY"), `the room is listed as extra bedding, not over capacity: ${roomsKinds.join()}`);
  const roomsView = await getAssignmentWorkspace(roomsEvent, { canSeeSensitive: false }, prisma);
  const familyCard = roomsView.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.units)).find((card) => card.eventUnitId === familyRoom.id)!;
  assert(familyCard.extraBedding && familyCard.status === "FULL", "the workspace shows the room as full with extra bedding");
  const familyPerson = roomsView.people.find((person) => person.registrationId === roomFamily.id)!;
  assert(familyPerson.roomCount === 1, "and the room count on the person");
  // Unit capacity still stops two separate parties from overfilling a room.
  const roomStranger = await makeReg(roomsEvent, [40]);
  await expectLodgingError(placeAt(roomsEvent, roomStranger.people[0]!, "girls-101"), "UNIT_FULL", "a second party into a room that is above its beds");
  const twoBeds = await makeReg(roomsEvent, [40, 40]);
  await placeAt(roomsEvent, twoBeds.people[0]!, "girls-103");
  await placeAt(roomsEvent, twoBeds.people[1]!, "girls-103");
  await expectLodgingError(placeAt(roomsEvent, roomStranger.people[0]!, "girls-103"), "UNIT_FULL", "a second party into a full two-bed room");
  // One party across two rooms is two rooms.
  await placeAt(roomsEvent, roomFamily.people[2]!, "girls-102", N[0], N[3], { mode: "MOVE" }, "Child moved to the next room");
  assert((await roomsFree()).every((value) => value === 0), `the party across two rooms counts two rooms, alongside the other party's room: ${(await roomsFree()).join()}`);
  // A waitlist entry carries a room count, from the request when it joins, and the database keeps it.
  const wants = await makeReg(roomsEvent, [40, 40, 40, 40]);
  await requestIn(roomsEvent, wants, { category: "DORM_ROOM", partySize: 4, roomCount: 2 });
  const joinedRooms = await applyWaitlistAction(roomsEvent, userId, { action: "join", registrationId: wants.id, category: "DORM_ROOM", partySize: 4 }, { now: new Date("2027-05-20T12:00:00Z") }, prisma);
  if (joinedRooms.action !== "join") throw new Error("FAILED: the join shape");
  const roomsEntry = await prisma.eventLodgingWaitlistEntry.findUniqueOrThrow({ where: { id: joinedRooms.entryId } });
  assert(roomsEntry.roomCount === 2, "a waitlist entry takes its room count from the request when it joins");
  const roomsPreview = await applyWaitlistAction(roomsEvent, userId, { action: "offer", entryIds: [roomsEntry.id] }, { now: new Date("2027-05-20T12:00:00Z") }, prisma);
  assert(roomsPreview.action === "offer" && !roomsPreview.confirmed && !roomsPreview.rows[0]!.eligible && roomsPreview.rows[0]!.roomCount === 2 && /No place is free for 2 rooms/.test(roomsPreview.rows[0]!.reason ?? ""), "no offer while the rooms are not free, counted in rooms");
  await expectDatabaseRefusal(prisma.eventLodgingWaitlistEntry.update({ where: { id: roomsEntry.id }, data: { roomCount: 1 } }), "changing the rooms an entry asked for");
  // A registrant's room count is capped at the party size, not at the room count of a request that is usually for another type.
  const capReg = await makeReg(roomsEvent, [40, 40, 40, 40]);
  await requestIn(roomsEvent, capReg, { category: "DORM_ROOM", partySize: 4, roomCount: 1 });
  const capJoin = await regActorFor(roomsEvent, capReg, { action: "join", category: "DORM_ROOM", partySize: 4, roomCount: 3 });
  assert((await prisma.eventLodgingWaitlistEntry.findUniqueOrThrow({ where: { id: capJoin.entryId } })).roomCount === 3, "a registrant's join may name up to the party size (the request is usually for another type), here 3 of 4");
  const noRequestReg = await makeReg(roomsEvent, [40, 40]);
  const noRequestJoin = await regActorFor(roomsEvent, noRequestReg, { action: "join", category: "DORM_ROOM", partySize: 2, roomCount: 9 });
  assert((await prisma.eventLodgingWaitlistEntry.findUniqueOrThrow({ where: { id: noRequestJoin.entryId } })).roomCount === 2, "and above the party size it is capped at the party, whether or not they have a request in that type");
  await expectLodgingError(applyWaitlistAction(roomsEvent, userId, { action: "join", registrationId: (await makeReg(roomsEvent, [40])).id, category: "DORM_ROOM", partySize: 1, roomCount: 2 }, { now: new Date("2027-05-20T12:00:00Z") }, prisma), "ROOM_COUNT_INVALID", "more rooms than people on a waitlist entry");

  // A plan that releases one assignment twice (two moves out of one long stay) keeps every revision and history row in step.
  const dblEvent = `${P}_ev_dbl`;
  await createEvent(dblEvent);
  await selectEventProperty(dblEvent, userId, { propertyKey: "sunnydale-academy" }, prisma);
  const dbl = await makeReg(dblEvent, [40]);
  await placeAt(dblEvent, dbl.people[0]!, "girls-101");
  await applyAssignmentAction(dblEvent, userId, { action: "place", reason: "Three separate nights elsewhere", placements: [
    { occupant: attendee(dbl.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(dblEvent, "girls-102")).id }, firstNight: N[1], lastNight: N[1], mode: "MOVE" },
    { occupant: attendee(dbl.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(dblEvent, "girls-104")).id }, firstNight: N[2], lastNight: N[2], mode: "MOVE" },
    { occupant: attendee(dbl.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(dblEvent, "girls-108")).id }, firstNight: N[0], lastNight: N[0], mode: "MOVE" },
  ] }, prisma);
  const dblRows = await prisma.eventLodgingAssignment.findMany({ where: { eventId: dblEvent, attendeeId: dbl.people[0]!.attendeeId } });
  for (const row of dblRows) {
    const rowHistory = await prisma.eventLodgingAssignmentHistory.findMany({ where: { assignmentId: row.id }, orderBy: { revision: "asc" } });
    assert(rowHistory.length === row.revision && rowHistory.every((entry, index) => entry.revision === index + 1), `every revision of an assignment released twice has its own history row (${row.id}: revision ${row.revision}, ${rowHistory.length} rows)`);
  }
  assert(dblRows.filter((row) => !row.cancelledAt).map((row) => `${night(row.firstNight)}..${night(row.lastNight)}`).sort().join() === `${N[0]}..${N[0]},${N[1]}..${N[1]},${N[2]}..${N[2]},${N[3]}..${N[3]}`, "the stay is split into one row per night, in the right rooms");
  // A remainder cut again in the same batch (nights 2 and 4 out of one stay) is written with its occupant from the real row.
  const cut = await makeReg(dblEvent, [40]);
  await placeAt(dblEvent, cut.people[0]!, "girls-101");
  await applyAssignmentAction(dblEvent, userId, { action: "place", reason: "Two nights elsewhere", placements: [
    { occupant: attendee(cut.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(dblEvent, "girls-102")).id }, firstNight: N[1], lastNight: N[1], mode: "MOVE" },
    { occupant: attendee(cut.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(dblEvent, "girls-104")).id }, firstNight: N[3], lastNight: N[3], mode: "MOVE" },
  ] }, prisma);
  const cutRows = await prisma.eventLodgingAssignment.findMany({ where: { eventId: dblEvent, attendeeId: cut.people[0]!.attendeeId } });
  for (const row of cutRows) {
    const rowHistory = await prisma.eventLodgingAssignmentHistory.count({ where: { assignmentId: row.id } });
    assert(rowHistory === row.revision, `each row of the twice-cut stay has its revisions in its history (${row.id}: revision ${row.revision}, ${rowHistory} rows)`);
  }
  assert(cutRows.filter((row) => !row.cancelledAt).map((row) => `${night(row.firstNight)}..${night(row.lastNight)}`).sort().join() === `${N[0]}..${N[0]},${N[1]}..${N[1]},${N[2]}..${N[2]},${N[3]}..${N[3]}`, "the twice-cut stay covers every night exactly once");
  // Assign then move in one batch is recorded as an assignment to the final room, linked to nothing that never existed.
  const quick = await makeReg(dblEvent, [40]);
  await applyAssignmentAction(dblEvent, userId, { action: "place", reason: "Assign then move", placements: [
    { occupant: attendee(quick.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(dblEvent, "girls-203")).id }, firstNight: N[0], lastNight: N[1] },
    { occupant: attendee(quick.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(dblEvent, "girls-205")).id }, firstNight: N[0], lastNight: N[1], mode: "MOVE" },
  ] }, prisma);
  const [quickRow] = await current(dblEvent, { attendeeId: quick.people[0]!.attendeeId });
  const quickHistory = await history([quickRow!.id]);
  assert(quickHistory.length === 1 && quickHistory[0]!.type === "ASSIGNED" && quickHistory[0]!.previousUnitId === null && quickHistory[0]!.relatedAssignmentId === null, `assign then move in one batch is recorded as one assignment to the final room (${JSON.stringify(quickHistory.map((entry) => [entry.type, entry.previousUnitId]))})`);

  // ---- What attendees see ------------------------------------------------------
  const host = await makeReg(eventId, [40]);
  const mate = await makeReg(eventId, [35]); // an adult on another registration
  const kid = await makeReg(eventId, [9]); // a child on another registration
  const unknownAge = await makeReg(eventId, [0]); // age never answered: never treated as an adult
  const sharedRoom = "girls-224";
  const sharedRow = await unitRow(eventId, sharedRoom);
  await updateEventUnit(eventId, sharedRow.id, userId, { capacityOverride: 4 }, prisma);
  for (const reg of [host, mate, kid, unknownAge]) await placeAt(eventId, reg.people[0]!, sharedRoom);
  assert((await registrant(host)).published === false && (await registrant(host)).stays.length === 0, "nothing is shown until staff publish");
  await expectLodgingError(sendRoomNotice(eventId, userId, host.id, prisma), "NOT_PUBLISHED", "a room notice before publishing");
  await updateAssignmentSettings(eventId, userId, { showAssignmentsToAttendees: true, attendeeInstructions: "Check in at the front office after 3 pm." }, prisma);
  const shown = await registrant(host);
  assert(shown.published && shown.stays.length === 1 && shown.stays[0]!.building === "Girls Dorm" && shown.stays[0]!.room === "224" && shown.instructions === "Check in at the front office after 3 pm.", "after publishing, the attendee sees building, room and instructions");
  assert(shown.stays[0]!.roommates.length === 0 && shown.stays[0]!.otherGuests === 0, "roommates are hidden unless staff turn them on");
  await updateAssignmentSettings(eventId, userId, { showRoommateFirstNames: true }, prisma);
  const withMates = await registrant(host);
  assert(withMates.stays[0]!.roommates.join() === mate.people[0]!.first && withMates.stays[0]!.otherGuests === 2, "roommates are first names only: another registration's adult is named, a child and an unknown age are only counted");
  const exposed = JSON.stringify(withMates);
  for (const other of [mate, kid, unknownAge]) {
    const person = other.people[0]!;
    assert(!exposed.includes(person.last) && !exposed.includes(person.email) && !exposed.includes(person.phone) && !exposed.includes(other.code), "the attendee view carries no last name, email, phone or confirmation code of anyone else");
  }
  assert(!/@|555-/.test(exposed), "no contact detail in the attendee view");
  const hostMates = await registrant(mate);
  assert(hostMates.stays[0]!.roommates.join() === host.people[0]!.first, "the other adult sees the first adult");
  await updateAssignmentSettings(eventId, userId, { showAssignmentsToAttendees: false }, prisma);
  assert((await prisma.eventLodging.findUniqueOrThrow({ where: { eventId } })).showRoommateFirstNames === false && !(await registrant(host)).published, "hiding the assignments hides roommates as well");
  await updateAssignmentSettings(eventId, userId, { showAssignmentsToAttendees: true, showRoommateFirstNames: true }, prisma);
  assert(await prisma.auditLog.count({ where: { eventId, action: "LODGING_ASSIGNMENT_SETTINGS_CHANGED" } }) >= 4, "each change of the display settings is audited");
  await prisma.registration.update({ where: { id: host.id }, data: { status: "CANCELLED" } });
  assert((await registrant(host)).stays.length === 0, "a cancelled registration sees no room");
  await prisma.registration.update({ where: { id: host.id }, data: { status: "CONFIRMED" } });
  assert((await getRegistrantAssignmentView({ eventId: otherEventId, registrationId: host.id }, prisma)).published === false, "a registration is shown nothing on another event");

  // ---- Room notices are versioned; a later change makes them obsolete -------------------
  const noticeA = await sendRoomNotice(eventId, userId, host.id, prisma);
  assert(!noticeA.alreadySent && noticeA.messageId, "a room notice is one email to one registration");
  const noticeMail = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: noticeA.messageId! } });
  assert(noticeMail.templateKey === "LODGING_ASSIGNMENT_NOTICE" && noticeMail.registrationId === host.id && noticeMail.bodyTextSnapshot.includes("224") && noticeMail.bodyTextSnapshot.includes("__IMSDA_PRIVATE_MANAGE_LINK__"), "it names the room and carries the private-link sentinel");
  assert(!noticeMail.bodyTextSnapshot.includes(mate.people[0]!.last) && !/@|555-/.test(noticeMail.bodyTextSnapshot.replace(noticeMail.recipientEmail, "")), "it holds no other guest's surname or contact detail");
  const noticeB = await sendRoomNotice(eventId, userId, host.id, prisma);
  assert(noticeB.alreadySent && noticeB.noticeId === noticeA.noticeId, "sending at an unchanged version queues nothing new");
  const notices1 = (await loadAssignmentFacts(prisma, eventId)).notices.find((notice) => notice.registrationId === host.id)!;
  assert(!notices1.obsolete, "the notice is current");
  // A later move makes it obsolete, and a notice that has not gone out yet is cancelled by the move.
  const pendingMail = await prisma.messageOutbox.create({
    data: {
      eventId, registrationId: host.id, templateKey: "LODGING_ASSIGNMENT_NOTICE", recipientKind: "REGISTRANT", recipientEmail: host.people[0]!.email, senderNameSnapshot: "Check", subjectSnapshot: "Pending", bodyTextSnapshot: "Pending",
      idempotencyKey: `${P}-pending-notice`, correlationId: randomUUID(), status: "PENDING",
    },
  });
  await prisma.eventLodgingAssignmentNotice.create({ data: { eventId, registrationId: host.id, outboxMessageId: pendingMail.id, assignmentVersion: notices1.currentVersion, contentHash: "0".repeat(64) } });
  await applyAssignmentAction(eventId, userId, { action: "place", reason: "Swapped rooms", placements: [{ occupant: attendee(host.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(eventId, "girls-228")).id }, firstNight: N[0], lastNight: N[3], mode: "MOVE" }] }, prisma);
  const notices2 = (await loadAssignmentFacts(prisma, eventId)).notices.find((notice) => notice.registrationId === host.id)!;
  assert(notices2.obsolete && notices2.currentVersion > notices2.assignmentVersion, "a later move makes the notice obsolete");
  assert((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: pendingMail.id } })).status === "CANCELLED", "a notice that had not gone out is cancelled by the move");
  assert((await workspace()).exceptions.some((row) => row.kind === "OBSOLETE_NOTICE"), "the obsolete notice is listed for closeout");
  const noticeC = await sendRoomNotice(eventId, userId, host.id, prisma);
  assert(!noticeC.alreadySent && noticeC.assignmentVersion > noticeA.assignmentVersion, "a new notice is a new version");
  assert((await registrant(host)).stays[0]!.room === "228", "the attendee view shows the latest room");
  const noticeIsObsolete = async () => (await loadAssignmentFacts(prisma, eventId)).notices.find((notice) => notice.registrationId === host.id)?.obsolete === true;
  let latestNoticeId = noticeC.noticeId;
  assert(!(await noticeIsObsolete()), "the newest notice is current");
  await updateAssignmentSettings(eventId, userId, { attendeeInstructions: "Check in at the gym instead." }, prisma);
  assert(await noticeIsObsolete(), "editing the arrival instructions makes the notice obsolete");
  latestNoticeId = (await sendRoomNotice(eventId, userId, host.id, prisma)).noticeId;
  assert(!(await noticeIsObsolete()), "a fresh notice is current again");
  await applyAssignmentAction(eventId, userId, { action: "place", reason: "Same room", placements: [{ occupant: attendee(mate.people[0]!), place: { kind: "UNIT", eventUnitId: (await unitRow(eventId, "girls-228")).id }, firstNight: N[0], lastNight: N[3], mode: "MOVE" }] }, prisma);
  assert(await noticeIsObsolete(), "a roommate moving in makes the notice obsolete although this registration's own assignment did not change");
  latestNoticeId = (await sendRoomNotice(eventId, userId, host.id, prisma)).noticeId;
  const room228 = await unitRow(eventId, "girls-228");
  await updateEventUnit(eventId, room228.id, userId, { unavailable: true, unavailableReason: "Burst pipe" }, prisma);
  assert(await noticeIsObsolete(), "closing the room makes the notice obsolete");
  await updateEventUnit(eventId, room228.id, userId, { unavailable: false }, prisma);
  latestNoticeId = (await sendRoomNotice(eventId, userId, host.id, prisma)).noticeId;
  // Send time: a notice that a later change made wrong is cancelled when it comes to be sent, not sent.
  const { lodgingMessageStaleReason } = await import("../modules/lodging/message-currency");
  const staleNotice = await prisma.eventLodgingAssignmentNotice.findUniqueOrThrow({ where: { id: latestNoticeId } });
  assert((await lodgingMessageStaleReason(staleNotice.outboxMessageId!, "LODGING_ASSIGNMENT_NOTICE")) === null, "a current notice passes the send-time check");
  await updateAssignmentSettings(eventId, userId, { attendeeInstructions: "Check in at the gym, side door." }, prisma);
  assert(Boolean(await lodgingMessageStaleReason(staleNotice.outboxMessageId!, "LODGING_ASSIGNMENT_NOTICE")), "a notice made wrong after it was queued is refused at send time");
  await updateAssignmentSettings(eventId, userId, { attendeeInstructions: "Check in at the front office after 3 pm." }, prisma);
  await expectDatabaseRefusal(prisma.eventLodgingAssignmentNotice.update({ where: { id: noticeA.noticeId }, data: { assignmentVersion: 99 } }), "rewriting a notice");
  await expectDatabaseRefusal(prisma.eventLodgingAssignmentNotice.delete({ where: { id: noticeA.noticeId } }), "deleting a notice");

  // ---- Inactive registrations, and cross-event integrity -------------------------------
  const quitter = await makeReg(eventId, [40]);
  await applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: attendee(quitter.people[0]!), place: { kind: "BUCKET", bucketId: hotelBucket.id }, firstNight: N[0], lastNight: N[0] }] }, prisma);
  await prisma.registration.update({ where: { id: quitter.id }, data: { status: "CANCELLED" } });
  assert((await exceptionKinds()).includes("INACTIVE_REGISTRATION"), "a cancelled registration that still holds a room is a closeout exception");
  await expectLodgingError(placeAt(eventId, quitter.people[0]!, "girls-104", N[2], N[3]), "REGISTRATION_NOT_ACTIVE", "placing a cancelled registration");
  const released = await applyAssignmentAction(eventId, userId, { action: "release_inactive", reason: "Registration cancelled" }, prisma);
  assert(released.released >= 1 && !(await exceptionKinds()).includes("INACTIVE_REGISTRATION"), "staff can release the rooms of inactive registrations, with history");
  await expectDatabaseRefusal(prisma.registration.delete({ where: { id: alice.id } }), "deleting a registration that holds a room (its history is kept)");
  await expectDatabaseRefusal(prisma.registrationAttendee.delete({ where: { id: alice.people[0]!.attendeeId } }), "deleting an attendee with room assignment history (the amendment guard reports ATTENDEE_HAS_HISTORY before this)");
  const otherReg = await makeReg(otherEventId, [40]);
  const otherUnit = await unitRow(otherEventId, "girls-101");
  await expectDatabaseRefusal(prisma.eventLodgingAssignment.create({ data: { eventId, eventLodgingUnitId: otherUnit.id, attendeeId: alice.people[0]!.attendeeId, firstNight: new Date(`${N[0]}T00:00:00Z`), lastNight: new Date(`${N[0]}T00:00:00Z`), source: "STAFF", revision: 1 } }), "a unit of another event");
  await expectDatabaseRefusal(prisma.eventLodgingAssignment.create({ data: { eventId, eventLodgingUnitId: room211.id, attendeeId: otherReg.people[0]!.attendeeId, firstNight: new Date(`${N[0]}T00:00:00Z`), lastNight: new Date(`${N[0]}T00:00:00Z`), source: "STAFF", revision: 1 } }), "an attendee of another event");
  await expectLodgingError(applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: attendee(otherReg.people[0]!), place: { kind: "UNIT", eventUnitId: room211.id }, firstNight: N[0], lastNight: N[0] }] }, prisma), "OCCUPANT_NOT_FOUND", "the service refuses an attendee of another event");
  await expectLodgingError(applyAssignmentAction(eventId, userId, { action: "place", placements: [{ occupant: attendee(alice.people[0]!), place: { kind: "UNIT", eventUnitId: otherUnit.id }, firstNight: N[0], lastNight: N[0], mode: "MOVE" }] }, prisma), "UNKNOWN_PLACE", "the service refuses a unit of another event");

  // ---- Nothing changed a charge -----------------------------------------------------------
  const sums = await prisma.registration.findMany({ where: { eventId }, select: { totalAmount: true } });
  assert(sums.every((row) => row.totalAmount.toString() === "0") && await prisma.payment.count({ where: { eventId } }) === paymentsBefore && await prisma.refund.count({ where: { eventId } }) === 0, "no registration total changed and no payment or refund was created");

  // ---- The event deletion service removes expected guests and their placements ------------------
  const { deleteEvent } = await import("../modules/events/deletion-repository");
  const deletableId = `${P}_ev_deletable`;
  await createEvent(deletableId);
  await selectEventProperty(deletableId, userId, { propertyKey: "sunnydale-academy" }, prisma);
  const ghost = await applyPlaceholderAction(deletableId, userId, { action: "create", displayName: "Expected speaker", headcount: 2 }, prisma);
  await applyAssignmentAction(deletableId, userId, { action: "place", placements: [{ occupant: { kind: "PLACEHOLDER", id: ghost.id }, place: { kind: "UNIT", eventUnitId: (await unitRow(deletableId, "girls-101")).id }, firstNight: N[0], lastNight: N[1] }] }, prisma);
  assert(await prisma.eventLodgingAssignmentHistory.count({ where: { eventId: deletableId } }) === 1, "the event to delete holds an assignment and its history");
  await deleteEvent({ eventId: deletableId, actor: { userId, globalRole: "SYSTEM_ADMIN" }, confirmName: `Lodging assignment check ${deletableId}` });
  assert(await prisma.event.count({ where: { id: deletableId } }) === 0 && await prisma.eventLodgingAssignment.count({ where: { eventId: deletableId } }) === 0 && await prisma.eventLodgingPlaceholder.count({ where: { eventId: deletableId } }) === 0 && await prisma.eventLodgingAssignmentHistory.count({ where: { eventId: deletableId } }) === 0, "deleting an event through the service removes its expected guests, placements and history");

  // ---- Rows go with their event, and only then -------------------------------------------------
  const counts = async () => Promise.all([
    prisma.eventLodgingAssignment.count({ where: { eventId } }),
    prisma.eventLodgingAssignmentHistory.count({ where: { eventId } }),
    prisma.eventLodgingPlaceholder.count({ where: { eventId } }),
    prisma.eventLodgingWaitlistEntry.count({ where: { eventId } }),
    prisma.eventLodgingWaitlistHistory.count({ where: { eventId } }),
    prisma.eventLodgingAssignmentNotice.count({ where: { eventId } }),
    prisma.eventLodgingBucket.count({ where: { eventId } }),
  ]);
  assert((await counts()).every((count) => count > 0), `the event holds rows of every kind before deletion: ${(await counts()).join()}`);
  // The event deletion service sets the transaction-local setting and removes these rows before the registrations.
  const refusal = await caught(prisma.$transaction(async (tx) => { await tx.eventLodgingAssignmentNotice.deleteMany({ where: { eventId } }); }));
  assert(refusal, "without the event-deletion setting a delete is refused");
  await prisma.event.delete({ where: { id: eventId } });
  const left = await counts();
  assert(left.every((count) => count === 0), `deleting an event removes its assignment rows, left ${left.join()}`);
  assert(await prisma.lodgingUnit.count() > 0, "the property inventory survives");

  console.log("Lodging assignment verified.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await cleanup(); } catch (error) { console.error("Cleanup failed:", error instanceof Error ? error.message : error); process.exitCode = 1; }
    await prisma.$disconnect();
  });
