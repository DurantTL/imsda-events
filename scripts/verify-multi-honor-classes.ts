/**
 * Proves a Honors Weekend class can teach several honors (#812) against a real
 * PostgreSQL database: the migration's backfill gives every existing class
 * exactly one honor row; the database itself refuses an honor taught twice in
 * one session (or twice across all sessions at one site) whichever class
 * teaches it, and keeps each honor row at its class's session and site;
 * enrolling in a multi-honor class takes one seat and shows every honor on the
 * picker, rosters and exports; the honors of a class are locked per honor once
 * anyone is enrolled; completing the class completes each honor, once; and
 * seats, honor edits and write-backs hold under races. Uses fictitious rows it
 * creates and removes itself.
 *
 *   npm run test:multi-honor-classes
 */
import { readFileSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import { ClassSelectionError, getClassSelectionWorkspace, setClassSelections } from "../modules/honors/enrollment-repository";
import {
  HonorConfigurationError,
  createHonorOffering,
  deleteHonorOffering,
  updateHonorOffering,
} from "../modules/honors/repository";
import { buildClassRosters, buildClubSchedule, classRostersCsv, clubScheduleCsv } from "../modules/honors/roster-domain";
import { getHonorRosterData } from "../modules/honors/roster-repository";
import { writeBackHonorsWeekendCompletions } from "../modules/honors/weekend-completion-repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "multihonor";
const adminId = `${P}_admin`;
const eventId = `${P}_event`;
const siteEventId = `${P}_site_event`;
const clubs = [`${P}_club_a`, `${P}_club_b`];
const honorIds = ["knots", "fire", "birds", "maps", "rope"].map((key) => `${P}_honor_${key}`);
const [knots, fire, birds, maps, rope] = honorIds as [string, string, string, string, string];
const now = new Date("2026-10-15T15:00:00Z");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

const prismaCode = (error: unknown) => (error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null);
const rejected = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);

async function cleanup() {
  const events = [eventId, siteEventId];
  await prisma.memberHonorEntry.deleteMany({ where: { honorId: { in: honorIds } } });
  await prisma.honorEnrollment.deleteMany({ where: { eventId: { in: events } } });
  await prisma.checkIn.deleteMany({ where: { eventId: { in: events } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: events } }, { actorUserId: adminId }] } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: { in: events } } });
  await prisma.registration.deleteMany({ where: { eventId: { in: events } } });
  await prisma.honorOffering.deleteMany({ where: { eventId: { in: events } } });
  await prisma.honorSession.deleteMany({ where: { eventId: { in: events } } });
  await prisma.honor.deleteMany({ where: { id: { in: honorIds } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { in: clubs } } });
  await prisma.eventLocation.deleteMany({ where: { eventId: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  await prisma.organization.deleteMany({ where: { id: { in: clubs } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.user.deleteMany({ where: { id: adminId } });
}

async function registerClub(clubId: string, people: Array<{ key: string; type: "YOUTH" | "STAFF" }>) {
  const holder = await prisma.person.create({ data: { id: `${P}_${clubId}_holder`, firstName: "Test", lastName: "Director" } });
  const registration = await prisma.registration.create({
    data: { eventId, accountHolderPersonId: holder.id, confirmationCode: `REG-${clubId}`, status: "SUBMITTED", totalAmount: 0, submittedAt: now },
  });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubId, registrationId: registration.id } });
  const attendees: Array<{ id: string; personId: string }> = [];
  for (const [position, person] of people.entries()) {
    const personRow = await prisma.person.create({ data: { id: `${P}_${clubId}_${person.key}`, firstName: "Test", lastName: person.key } });
    const member = await prisma.clubRosterMember.create({
      data: { organizationId: clubId, clubYear: "2026-27", personId: personRow.id, attendeeType: person.type, source: "DIRECTOR" },
    });
    const attendee = await prisma.registrationAttendee.create({
      data: {
        eventId, registrationId: registration.id, personId: personRow.id, attendeeType: person.type, position,
        profileSnapshot: { firstName: "Test", lastName: person.key, ageOnEventDate: 12, clubRosterMemberId: member.id },
      },
    });
    attendees.push({ id: attendee.id, personId: personRow.id });
  }
  return attendees;
}

const offeringInput = (honors: string[], sessionId: string, extra: Record<string, unknown> = {}) => ({
  honorIds: honors, span: "SINGLE_SESSION" as const, sessionId, locationId: null, capacity: 10, minimumAge: null, perClubLimit: null,
  teacherName: "Synthetic Teacher", location: "Room 1", additionalCostCents: null, requirementNote: "", isActive: true, ...extra,
});

const joinRows = (offeringId: string) => prisma.honorOfferingHonor.findMany({ where: { offeringId }, orderBy: { position: "asc" } });

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: adminId, email: `${P}-admin@example.test`, displayName: "Multi Honor Admin", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.createMany({
    data: clubs.map((id) => ({ id, type: "CLUB" as const, name: `Multi ${id}`, normalizedName: `multi ${id}` })),
  });
  await prisma.honor.createMany({
    data: honorIds.map((id) => ({ id, code: `MH-${id.slice(-4).toUpperCase()}`, name: `Multi ${id.slice(P.length + 7)}`, normalizedName: `multi ${id}` })),
  });
  for (const [id, slug] of [[eventId, "event"], [siteEventId, "site-event"]] as const) {
    await prisma.event.create({
      data: {
        id, slug: `${P}-${slug}`, name: `Multi honor verification ${slug}`, startsAt: new Date("2026-12-05T15:00:00Z"),
        endsAt: new Date("2026-12-06T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-10-01",
        registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
      },
    });
  }
  const sabbath = await prisma.honorSession.create({ data: { eventId, name: "Sabbath", normalizedName: "sabbath", sortOrder: 0 } });
  const sunday = await prisma.honorSession.create({ data: { eventId, name: "Sunday", normalizedName: "sunday", sortOrder: 1 } });

  // 1. Backfill: the migration's INSERT gives a class that had one honor exactly one row, at position 0, copying its placement.
  const migration = readFileSync("prisma/migrations/20261009100000_honor_offering_multiple_honors/migration.sql", "utf8");
  const backfill = migration.match(/INSERT INTO "HonorOfferingHonor"[\s\S]*?FROM "HonorOffering" o;/)?.[0];
  assert(backfill, "the migration should contain the backfill INSERT");
  const legacySingle = await prisma.honorOffering.create({ data: { eventId, honorId: maps, sessionId: sabbath.id, span: "SINGLE_SESSION", capacity: 4 } });
  const legacyAll = await prisma.honorOffering.create({ data: { eventId, honorId: rope, sessionId: null, span: "ALL_SESSIONS", capacity: 4 } });
  // Make them look as they did before the migration: a class with no join row.
  await prisma.honorOfferingHonor.deleteMany({ where: { offeringId: { in: [legacySingle.id, legacyAll.id] } } });
  const scoped = backfill.replace(/FROM "HonorOffering" o;$/, `FROM "HonorOffering" o WHERE o."eventId" = '${eventId}' AND NOT EXISTS (SELECT 1 FROM "HonorOfferingHonor" h WHERE h."offeringId" = o."id");`);
  await prisma.$executeRawUnsafe(scoped);
  for (const [legacy, honorId, sessionId] of [[legacySingle, maps, sabbath.id], [legacyAll, rope, null]] as const) {
    const rows = await joinRows(legacy.id);
    assert(rows.length === 1, `backfill should give the class exactly one row, got ${rows.length}`);
    assert(rows[0]!.honorId === honorId && rows[0]!.position === 0 && rows[0]!.eventId === eventId && rows[0]!.sessionId === sessionId && rows[0]!.locationId === null,
      "the backfilled row should copy the class's honor, event, session and site");
  }
  await prisma.$executeRawUnsafe(scoped);
  assert(await prisma.honorOfferingHonor.count({ where: { eventId, honorId: { in: [maps, rope] } } }) === 2, "running the backfill again must add nothing");
  await prisma.honorOffering.deleteMany({ where: { id: { in: [legacySingle.id, legacyAll.id] } } });
  assert(await prisma.honorOfferingHonor.count({ where: { eventId } }) === 0, "deleting a class deletes its honor rows");
  console.log("ok  backfill: each existing class got exactly one honor row (idempotent), and rows go with their class");

  // 2. The database keeps the rows at the class's placement, and refuses an honor twice in one session.
  const plain = await prisma.honorOffering.create({ data: { eventId, honorId: knots, sessionId: sabbath.id, span: "SINGLE_SESSION", capacity: 5 } });
  const plainRows = await joinRows(plain.id);
  assert(plainRows.length === 1 && plainRows[0]!.honorId === knots && plainRows[0]!.sessionId === sabbath.id && plainRows[0]!.position === 0,
    "a new class gets its primary honor's row from the trigger");
  await prisma.honorOffering.update({ where: { id: plain.id }, data: { sessionId: sunday.id } });
  assert((await joinRows(plain.id))[0]!.sessionId === sunday.id, "moving a class moves its honor rows");
  const sameSession = await prisma.honorOffering.create({ data: { eventId, honorId: fire, sessionId: sunday.id, span: "SINGLE_SESSION", capacity: 5 } });
  assert(prismaCode(await rejected(prisma.honorOfferingHonor.create({ data: { offeringId: sameSession.id, honorId: knots, eventId, position: 1 } }))) === "P2002",
    "the same honor in a second class of one session must be refused by the database");
  await prisma.honorOfferingHonor.create({ data: { offeringId: sameSession.id, honorId: birds, eventId, position: 1 } });
  await prisma.honorOffering.update({ where: { id: sameSession.id }, data: { sessionId: sabbath.id } });
  assert((await joinRows(sameSession.id)).every((row) => row.sessionId === sabbath.id), "every honor row of a moved class follows it");
  await prisma.honorOffering.create({ data: { eventId, honorId: birds, sessionId: sunday.id, span: "SINGLE_SESSION", capacity: 5 } });
  assert(prismaCode(await rejected(prisma.honorOffering.update({ where: { id: sameSession.id }, data: { sessionId: sunday.id } }))) === "P2002",
    "moving a class where one of its honors is already taught must be refused by the database");
  await prisma.honorOffering.deleteMany({ where: { eventId } });
  console.log("ok  database: rows follow their class, and an honor can't be taught twice in a session by any class");

  // 3. All-sessions classes: one per honor per event with no site, and per honor per site.
  const allA = await prisma.honorOffering.create({ data: { eventId, honorId: knots, sessionId: null, span: "ALL_SESSIONS", capacity: 5 } });
  await prisma.honorOfferingHonor.create({ data: { offeringId: allA.id, honorId: fire, eventId, position: 1 } });
  const allB = await prisma.honorOffering.create({ data: { eventId, honorId: birds, sessionId: null, span: "ALL_SESSIONS", capacity: 5 } });
  assert(prismaCode(await rejected(prisma.honorOfferingHonor.create({ data: { offeringId: allB.id, honorId: fire, eventId, position: 1 } }))) === "P2002",
    "an honor in two all-sessions classes with no site must be refused");
  assert(prismaCode(await rejected(prisma.honorOffering.create({ data: { eventId, honorId: knots, sessionId: null, span: "ALL_SESSIONS", capacity: 5 } }))) === "P2002",
    "the primary honor in a second all-sessions class with no site must be refused");
  await prisma.honorOffering.deleteMany({ where: { eventId } });
  const siteA = await prisma.eventLocation.create({ data: { eventId: siteEventId, name: "Site A", normalizedName: "site a", sortOrder: 0 } });
  const siteB = await prisma.eventLocation.create({ data: { eventId: siteEventId, name: "Site B", normalizedName: "site b", sortOrder: 1 } });
  const atA = await prisma.honorOffering.create({ data: { eventId: siteEventId, honorId: knots, sessionId: null, locationId: siteA.id, span: "ALL_SESSIONS", capacity: 5 } });
  await prisma.honorOfferingHonor.create({ data: { offeringId: atA.id, honorId: fire, eventId: siteEventId, position: 1 } });
  const atB = await prisma.honorOffering.create({ data: { eventId: siteEventId, honorId: knots, sessionId: null, locationId: siteB.id, span: "ALL_SESSIONS", capacity: 5 } });
  await prisma.honorOfferingHonor.create({ data: { offeringId: atB.id, honorId: fire, eventId: siteEventId, position: 1 } });
  assert((await joinRows(atB.id)).every((row) => row.locationId === siteB.id), "an all-sessions class's rows carry its site");
  const sameSite = await prisma.honorOffering.create({ data: { eventId: siteEventId, honorId: birds, sessionId: null, locationId: siteA.id, span: "ALL_SESSIONS", capacity: 5 } });
  assert(prismaCode(await rejected(prisma.honorOfferingHonor.create({ data: { offeringId: sameSite.id, honorId: fire, eventId: siteEventId, position: 1 } }))) === "P2002",
    "an honor in two all-sessions classes at one site must be refused");
  await prisma.honorOffering.deleteMany({ where: { eventId: siteEventId } });
  console.log("ok  database: all-sessions classes are one per honor per site (or per event with no site), for every honor taught");

  // 4. A class with several honors: create, enroll, and see every honor everywhere.
  const [a1, a2, aStaff] = await registerClub(clubs[0], [{ key: "youth1", type: "YOUTH" }, { key: "youth2", type: "YOUTH" }, { key: "staff", type: "STAFF" }]);
  const [b1] = await registerClub(clubs[1], [{ key: "youth1", type: "YOUTH" }]);
  assert(a1 && a2 && aStaff && b1, "fixtures");
  const setup = await createHonorOffering(eventId, offeringInput([knots, fire, birds], sabbath.id, { capacity: 3 }), adminId);
  const multi = setup.offerings.find((offering) => offering.honorIds.length === 3);
  assert(multi && multi.honorId === knots && multi.honorName.split(" + ").length === 3, "the class teaches three honors, the first as primary");
  assert((await joinRows(multi.id)).map((row) => row.honorId).join() === [knots, fire, birds].join(), "rows are in the order chosen");
  const dup = await rejected(createHonorOffering(eventId, offeringInput([maps, fire], sabbath.id), adminId));
  assert(dup instanceof HonorConfigurationError && dup.code === "OFFERING_CONFLICT", "another Sabbath class teaching fire must be refused with a message");
  assert(!(await prisma.honorOffering.findFirst({ where: { eventId, honorId: maps } })), "a refused class leaves nothing behind");
  const sundayClass = await createHonorOffering(eventId, offeringInput([fire, maps], sunday.id), adminId);
  assert(sundayClass.offerings.length === 2, "the same honor may be taught in another session");

  await setClassSelections(clubs[0], eventId, { accountId: "director-a" }, { [a1.id]: [multi.id], [aStaff.id]: [multi.id] }, now);
  const workspace = await getClassSelectionWorkspace(clubs[0], eventId, now);
  const pickerClass = workspace.offerings.find((offering) => offering.id === multi.id)!;
  assert(pickerClass.seatsTaken === 1, `one youth is one seat however many honors the class teaches, got ${pickerClass.seatsTaken}`);
  assert(multi.honorName.split(" + ").every((name) => pickerClass.honorName.includes(name)), "the picker names every honor of the class");
  const rosterData = await getHonorRosterData(eventId, { includeDietary: false });
  assert(rosterData, "roster data");
  const rosters = buildClassRosters(rosterData.sessions, rosterData.offerings, rosterData.enrollments, rosterData.attendees);
  const multiRoster = rosters.find((roster) => roster.offering.id === multi.id)!;
  assert(multiRoster.people.length === 2 && multiRoster.youthSeats === 1, "the class roster lists the youth and the staff member, one youth seat");
  const csv = classRostersCsv(rosters);
  const scheduleCsv = clubScheduleCsv(buildClubSchedule(clubs[0], rosterData.sessions, rosterData.offerings, rosterData.enrollments, rosterData.attendees, rosterData.locations));
  for (const name of multi.honorName.split(" + ")) {
    assert(csv.includes(name), `the class roster CSV should name ${name}`);
    assert(scheduleCsv.includes(name), `the club schedule CSV should name ${name}`);
  }
  assert(multi.honorCode.split(" + ").every((code) => csv.includes(code)), "the class roster CSV carries every honor code");
  console.log("ok  enrolling takes one seat, and the picker, rosters and CSVs show every honor of the class");

  // 5. The lock, per honor.
  const refusal = async (honors: string[]) => {
    const error = await rejected(updateHonorOffering(eventId, multi.id, { honorIds: honors }, adminId));
    assert(error instanceof HonorConfigurationError && error.code === "OFFERING_HAS_PICKS", `changing the honors to [${honors.length}] after enrollment must be refused`);
    return error.message;
  };
  assert((await refusal([knots, fire])).includes("can't be removed"), "removing an honor is refused, and says so");
  assert((await refusal([knots, fire, birds, rope])).includes("can't be added"), "adding an honor is refused, and says so");
  assert((await joinRows(multi.id)).length === 3, "a refused edit changes nothing");
  await updateHonorOffering(eventId, multi.id, { honorIds: [fire, birds, knots], capacity: 4, teacherName: "New Synthetic Teacher" }, adminId);
  const reordered = await prisma.honorOffering.findUniqueOrThrow({ where: { id: multi.id } });
  assert(reordered.honorId === fire && reordered.capacity === 4, "the same honors in another order, with new seats, is allowed and the primary follows");
  assert((await joinRows(multi.id)).map((row) => row.honorId).join() === [fire, birds, knots].join(), "the rows follow the new order");
  const deleteWithPick = await rejected(deleteHonorOffering(eventId, multi.id, adminId));
  assert(deleteWithPick instanceof HonorConfigurationError && deleteWithPick.code === "PICKS_NEED_CONFIRMATION", "deleting an enrolled class needs the count confirmed");
  console.log("ok  lock: once enrolled, no honor can be removed or added (named in the message); order, seats and teacher can change");

  // 6. Completion: checked-in enrollees complete every honor, once.
  await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: a1.id, idempotencyKey: `${P}-checkin-a1` } });
  const first = await writeBackHonorsWeekendCompletions(eventId, adminId);
  assert(first.written === 3 && first.alreadyRecorded === 0, `three honors should be written, got ${JSON.stringify(first)}`);
  const entries = await prisma.memberHonorEntry.findMany({ where: { personId: a1.personId } });
  assert(entries.length === 3 && entries.every((entry) => entry.status === "COMPLETED") && new Set(entries.map((entry) => entry.honorId)).size === 3,
    "one COMPLETED entry per honor the class teaches");
  const links = await prisma.honorWeekendCompletionLink.findMany({ where: { enrollment: { eventId } } });
  assert(links.length === 3 && new Set(links.map((link) => link.honorId)).size === 3, "one link per honor");
  const again = await writeBackHonorsWeekendCompletions(eventId, adminId);
  assert(again.written === 0 && again.alreadyRecorded === 3, `running again writes nothing, got ${JSON.stringify(again)}`);
  assert(await prisma.memberHonorEntry.count({ where: { personId: a1.personId } }) === 3, "no duplicate entries");
  const blocked = await rejected(deleteHonorOffering(eventId, multi.id, adminId, 2));
  assert(blocked instanceof HonorConfigurationError && blocked.code === "HAS_WRITTEN_BACK_COMPLETIONS", "a class with written-back honors can't be deleted");
  // A member who already completed one of the honors by hand gets a link to it, not a second record.
  const priorEntry = await prisma.memberHonorEntry.create({ data: { personId: b1.personId, honorId: fire, status: "COMPLETED", completionDate: "2026-01-01", organizationId: clubs[1] } });
  await setClassSelections(clubs[1], eventId, { accountId: "director-b" }, { [b1.id]: [multi.id] }, now);
  await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: b1.id, idempotencyKey: `${P}-checkin-b1` } });
  const second = await writeBackHonorsWeekendCompletions(eventId, adminId);
  assert(second.written === 2 && second.alreadyRecorded === 4, `two new entries and one link to the existing, got ${JSON.stringify(second)}`);
  assert(await prisma.memberHonorEntry.count({ where: { personId: b1.personId, honorId: fire } }) === 1, "the hand-recorded honor isn't recorded twice");
  assert(await prisma.honorWeekendCompletionLink.count({ where: { memberHonorEntryId: priorEntry.id } }) === 1, "the enrollment links to the existing record");
  console.log("ok  completion: each honor of the class completed once per enrollee; reruns and prior records write nothing twice");

  // 7. Races.
  // 7a. Two clubs race for the last seat of a multi-honor class: one wins, and the seat is counted once.
  const raceClass = (await createHonorOffering(eventId, offeringInput([rope, maps], sabbath.id, { capacity: 1 }), adminId)).offerings.find((offering) => offering.honorIds.includes(rope))!;
  const racers = await Promise.allSettled([
    setClassSelections(clubs[0], eventId, { accountId: "director-a" }, { [a2.id]: [raceClass.id] }, now),
    setClassSelections(clubs[1], eventId, { accountId: "director-b" }, { [b1.id]: [raceClass.id] }, now),
  ]);
  const winners = racers.filter((result) => result.status === "fulfilled").length;
  const loser = racers.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(winners === 1 && loser && loser.reason instanceof ClassSelectionError && loser.reason.code === "CLASS_FULL", "exactly one club gets the last seat");
  assert(await prisma.honorEnrollment.count({ where: { offeringId: raceClass.id, consumesSeat: true } }) === 1, "one seat taken, however many honors");
  // 7b. The same person saved twice at once: one enrollment.
  const twin = (await createHonorOffering(eventId, offeringInput([birds], sunday.id), adminId)).offerings.find((offering) => offering.honorIds.join() === birds)!;
  const same = await Promise.allSettled([
    setClassSelections(clubs[0], eventId, { accountId: "director-a" }, { [a1.id]: [twin.id] }, now),
    setClassSelections(clubs[0], eventId, { accountId: "director-a" }, { [a1.id]: [twin.id] }, now),
  ]);
  assert(same.some((result) => result.status === "fulfilled"), "a double save still saves");
  assert(await prisma.honorEnrollment.count({ where: { registrationAttendeeId: a1.id, offeringId: twin.id } }) === 1, "a double save makes one enrollment");
  // 7c. Two staff members add the same honor to two different classes of one session at once: exactly one wins.
  const sessionThree = await prisma.honorSession.create({ data: { eventId, name: "Evening", normalizedName: "evening", sortOrder: 2 } });
  const left = (await createHonorOffering(eventId, offeringInput([knots], sessionThree.id), adminId)).offerings.find((offering) => offering.sessionId === sessionThree.id)!;
  const right = (await createHonorOffering(eventId, offeringInput([fire], sessionThree.id), adminId)).offerings.find((offering) => offering.sessionId === sessionThree.id && offering.id !== left.id)!;
  const edits = await Promise.allSettled([
    updateHonorOffering(eventId, left.id, { honorIds: [knots, maps] }, adminId),
    updateHonorOffering(eventId, right.id, { honorIds: [fire, maps] }, adminId),
  ]);
  const edited = edits.filter((result) => result.status === "fulfilled").length;
  assert(edited === 1, `exactly one of two racing edits adding the same honor to one session should win, got ${edited}`);
  const mapsInSession = await prisma.honorOfferingHonor.count({ where: { sessionId: sessionThree.id, honorId: maps } });
  assert(mapsInSession === 1, `the honor is taught once in the session, found ${mapsInSession}`);
  const lostEdit = edits.find((result): result is PromiseRejectedResult => result.status === "rejected")!;
  assert(lostEdit.reason instanceof HonorConfigurationError && lostEdit.reason.code === "OFFERING_CONFLICT", "the loser is told the honor is already offered");
  // 7d. Two write-backs at once write nothing twice.
  await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: a2.id, idempotencyKey: `${P}-checkin-a2` } });
  const before = await prisma.memberHonorEntry.count({ where: { honorId: { in: honorIds } } });
  await Promise.allSettled([writeBackHonorsWeekendCompletions(eventId, adminId), writeBackHonorsWeekendCompletions(eventId, adminId)]);
  const afterRuns = await prisma.memberHonorEntry.groupBy({ by: ["personId", "honorId"], where: { honorId: { in: honorIds } }, _count: { _all: true } });
  assert(afterRuns.every((row) => row._count._all === 1), "no person has two COMPLETED records for one honor after racing write-backs");
  assert(afterRuns.length >= before, "the racing write-backs lost nothing");
  const dupLinks = await prisma.honorWeekendCompletionLink.groupBy({ by: ["enrollmentId", "honorId"], where: { enrollment: { eventId } }, _count: { _all: true } });
  assert(dupLinks.every((row) => row._count._all === 1), "one link per enrollment and honor");
  console.log("ok  races: one winner for the last seat, a double save is one enrollment, racing honor edits and write-backs write nothing twice");

  // 8. Deleting an unpicked class removes its honors; the event cascade removes the rest (cleanup proves it).
  const spare = (await createHonorOffering(eventId, offeringInput([rope], sessionThree.id), adminId)).offerings.find((offering) => offering.sessionId === sessionThree.id && offering.honorIds.join() === rope)!;
  await deleteHonorOffering(eventId, spare.id, adminId);
  assert(await prisma.honorOfferingHonor.count({ where: { offeringId: spare.id } }) === 0, "deleting a class deletes its honor rows");
  const primaryConsistent = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM "HonorOffering" o
    WHERE o."eventId" = ${eventId}
      AND NOT EXISTS (SELECT 1 FROM "HonorOfferingHonor" h WHERE h."offeringId" = o."id" AND h."honorId" = o."honorId" AND h."position" = 0)`;
  assert(Number(primaryConsistent[0]!.count) === 0, "every class's primary honor is its position-0 row");
  console.log("ok  every class's primary honor is its first row");
}

main()
  .then(() => console.log("Multi-honor class verification passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
