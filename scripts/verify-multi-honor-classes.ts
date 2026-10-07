/**
 * Proves a Honors Weekend class can teach several honors (#812) against a real
 * PostgreSQL database: the migration's backfill gives every existing class
 * exactly one honor row; the database itself refuses an honor taught twice in
 * one session (or twice across all sessions at one site) whichever class
 * teaches it, and keeps each honor row at its class's session and site;
 * enrolling in a multi-honor class takes one seat and shows every honor on the
 * picker, rosters and exports; staff can add or remove a class's honors after
 * people enrolled (with the enrolled count confirmed) unless an honor was already
 * written back as completed; editing honors while moving a class works; completing
 * the class completes each honor, once; and seats, honor edits and write-backs
 * hold under races. Uses fictitious rows it
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
const honorIds = ["knots", "fire", "birds", "maps", "rope", "compass"].map((key) => `${P}_honor_${key}`);
const [knots, fire, birds, maps, rope, compass] = honorIds as [string, string, string, string, string, string];
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
  const backfill = migration.match(/INSERT INTO "HonorOfferingHonor"[\s\S]*?;/)?.[0];
  assert(backfill, "the migration should contain the backfill INSERT");
  const legacySingle = await prisma.honorOffering.create({ data: { eventId, honorId: maps, sessionId: sabbath.id, span: "SINGLE_SESSION", capacity: 4 } });
  const legacyAll = await prisma.honorOffering.create({ data: { eventId, honorId: rope, sessionId: null, span: "ALL_SESSIONS", capacity: 4 } });
  // Make them look as they did before the migration: a class with no join row.
  await prisma.honorOfferingHonor.deleteMany({ where: { offeringId: { in: [legacySingle.id, legacyAll.id] } } });
  // The migration's own statement, unchanged and across every class in the database.
  await prisma.$executeRawUnsafe(backfill);
  for (const [legacy, honorId, sessionId] of [[legacySingle, maps, sabbath.id], [legacyAll, rope, null]] as const) {
    const rows = await joinRows(legacy.id);
    assert(rows.length === 1, `backfill should give the class exactly one row, got ${rows.length}`);
    assert(rows[0]!.honorId === honorId && rows[0]!.position === 0 && rows[0]!.eventId === eventId && rows[0]!.sessionId === sessionId && rows[0]!.locationId === null,
      "the backfilled row should copy the class's honor, event, session and site");
  }
  const rowsBefore = await prisma.honorOfferingHonor.count();
  await prisma.$executeRawUnsafe(backfill);
  assert(await prisma.honorOfferingHonor.count() === rowsBefore, "running the migration's own backfill statement again must add nothing");
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

  // 5. Changing the honors after people enrolled: allowed, with the enrolled count confirmed (#812).
  const enrolledNow = await prisma.honorEnrollment.count({ where: { offeringId: multi.id } });
  assert(enrolledNow === 2, `two people are enrolled, found ${enrolledNow}`);
  const unconfirmed = await rejected(updateHonorOffering(eventId, multi.id, { honorIds: [knots, fire] }, adminId));
  assert(unconfirmed instanceof HonorConfigurationError && unconfirmed.code === "HONORS_NEED_CONFIRMATION" && unconfirmed.picks === 2
    && unconfirmed.message.startsWith("2 people are enrolled. They will now take:"), "removing an honor asks for the enrolled count first");
  const stale = await rejected(updateHonorOffering(eventId, multi.id, { honorIds: [knots, fire], confirmEnrolled: 1 }, adminId));
  assert(stale instanceof HonorConfigurationError && stale.code === "HONORS_NEED_CONFIRMATION" && stale.picks === 2, "a stale count is refused with the live one");
  assert((await joinRows(multi.id)).length === 3, "a refused edit changes nothing");
  await updateHonorOffering(eventId, multi.id, { honorIds: [knots, fire], confirmEnrolled: 2 }, adminId);
  assert((await joinRows(multi.id)).map((row) => row.honorId).join() === [knots, fire].join(), "an honor was removed after enrollment");
  assert(await prisma.honorEnrollment.count({ where: { offeringId: multi.id } }) === 2, "the enrollments stay");
  await updateHonorOffering(eventId, multi.id, { honorIds: [knots, fire, maps], confirmEnrolled: 2 }, adminId);
  assert((await joinRows(multi.id)).map((row) => row.honorId).join() === [knots, fire, maps].join(), "an honor was added after enrollment");
  const afterAdd = await getClassSelectionWorkspace(clubs[0], eventId, now);
  assert(afterAdd.offerings.find((offering) => offering.id === multi.id)!.honorName.includes("Multi maps"), "the picker shows the added honor, so the enrolled students now take it");
  await updateHonorOffering(eventId, multi.id, { honorIds: [fire, knots, maps], capacity: 4, teacherName: "New Synthetic Teacher" }, adminId);
  const reordered = await prisma.honorOffering.findUniqueOrThrow({ where: { id: multi.id } });
  assert(reordered.honorId === fire && reordered.capacity === 4, "the same honors in another order, with new seats, needs no confirmation and the primary follows");
  const moved = await rejected(updateHonorOffering(eventId, multi.id, { sessionId: sunday.id }, adminId));
  assert(moved instanceof HonorConfigurationError && moved.code === "OFFERING_HAS_PICKS", "an enrolled class still can't move to another session");
  const deleteWithPick = await rejected(deleteHonorOffering(eventId, multi.id, adminId));
  assert(deleteWithPick instanceof HonorConfigurationError && deleteWithPick.code === "PICKS_NEED_CONFIRMATION", "deleting an enrolled class needs the count confirmed");
  console.log("ok  honors can be added and removed after enrollment once the enrolled count is confirmed; order, seats and teacher need no confirmation");

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
  // An honor already recorded as completed can't come off the class; another one can still be added.
  const recorded = await rejected(updateHonorOffering(eventId, multi.id, { honorIds: [fire, knots], confirmEnrolled: 2 }, adminId));
  assert(recorded instanceof HonorConfigurationError && recorded.code === "HAS_WRITTEN_BACK_COMPLETIONS"
    && recorded.message.includes("was already recorded as completed for 1 person") && recorded.message.includes("Void those records first."),
  `removing an honor already written back must be refused with the student count, got ${String(recorded && (recorded as Error).message)}`);
  assert((await joinRows(multi.id)).length === 3, "the refused removal changed nothing");
  await updateHonorOffering(eventId, multi.id, { honorIds: [fire, knots, maps, birds], confirmEnrolled: 2 }, adminId);
  const afterAddWrite = await writeBackHonorsWeekendCompletions(eventId, adminId);
  assert(afterAddWrite.written === 1 && afterAddWrite.alreadyRecorded === 3, `the added honor is written back for the enrollee, got ${JSON.stringify(afterAddWrite)}`);
  assert(await prisma.memberHonorEntry.count({ where: { personId: a1.personId } }) === 4, "the enrollee now has all four honors");
  const blocked = await rejected(deleteHonorOffering(eventId, multi.id, adminId, 2));
  assert(blocked instanceof HonorConfigurationError && blocked.code === "HAS_WRITTEN_BACK_COMPLETIONS", "a class with written-back honors can't be deleted");
  // A member who already completed one of the honors by hand gets a link to it, not a second record.
  const priorEntry = await prisma.memberHonorEntry.create({ data: { personId: b1.personId, honorId: fire, status: "COMPLETED", completionDate: "2026-01-01", organizationId: clubs[1] } });
  await setClassSelections(clubs[1], eventId, { accountId: "director-b" }, { [b1.id]: [multi.id] }, now);
  await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: b1.id, idempotencyKey: `${P}-checkin-b1` } });
  const second = await writeBackHonorsWeekendCompletions(eventId, adminId);
  assert(second.written === 3 && second.alreadyRecorded === 5, `three new entries and one link to the existing, got ${JSON.stringify(second)}`);
  assert(await prisma.memberHonorEntry.count({ where: { personId: b1.personId, honorId: fire } }) === 1, "the hand-recorded honor isn't recorded twice");
  assert(await prisma.honorWeekendCompletionLink.count({ where: { memberHonorEntryId: priorEntry.id } }) === 1, "the enrollment links to the existing record");
  console.log("ok  completion: each honor of the class completed once per enrollee; reruns and prior records write nothing twice");

  // 7. Races.
  // 7a. Two clubs race for the last seat of a multi-honor class: one wins, and the seat is counted once.
  const raceClass = (await createHonorOffering(eventId, offeringInput([rope, compass], sabbath.id, { capacity: 1 }), adminId)).offerings.find((offering) => offering.honorIds.includes(rope))!;
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

  // 7e. An honor edit and an enrollment at the same moment: one is retried or refused, and the result is consistent.
  const night = await prisma.honorSession.create({ data: { eventId, name: "Night", normalizedName: "night", sortOrder: 3 } });
  const nightClass = (await createHonorOffering(eventId, offeringInput([knots], night.id), adminId)).offerings.find((offering) => offering.sessionId === night.id)!;
  await setClassSelections(clubs[0], eventId, { accountId: "director-a" }, { [a2.id]: [nightClass.id] }, now);
  const editRace = await Promise.allSettled([
    updateHonorOffering(eventId, nightClass.id, { honorIds: [knots, compass], confirmEnrolled: 1 }, adminId),
    setClassSelections(clubs[1], eventId, { accountId: "director-b" }, { [b1.id]: [nightClass.id] }, now),
  ]);
  assert(editRace[1].status === "fulfilled", "the enrollment is saved whichever way the race goes");
  const enrolledAfterRace = await prisma.honorEnrollment.count({ where: { offeringId: nightClass.id } });
  assert(enrolledAfterRace === 2, `both students are enrolled, found ${enrolledAfterRace}`);
  const editResult = editRace[0];
  if (editResult.status === "rejected") {
    // The enrollment landed first: the confirmed count was stale, so staff are asked again with the live one.
    const reason = editResult.reason;
    assert(reason instanceof HonorConfigurationError && reason.code === "HONORS_NEED_CONFIRMATION" && reason.picks === 2, `a losing edit must ask again with the live count, got ${String(reason)}`);
    assert((await joinRows(nightClass.id)).length === 1, "a refused edit changed nothing");
    await updateHonorOffering(eventId, nightClass.id, { honorIds: [knots, compass], confirmEnrolled: 2 }, adminId);
  }
  assert((await joinRows(nightClass.id)).length === 2, "the honors end up as edited, for both enrollees");
  console.log("ok  an honor edit racing an enrollment either applies or asks again with the live count, and both end consistent");

  // 9. Editing honors while moving a class: dropped honors go first, so a move can't collide with them (#812).
  const sab2 = await prisma.honorSession.create({ data: { eventId: siteEventId, locationId: siteA.id, name: "Sabbath", normalizedName: "sabbath", sortOrder: 0 } });
  const sun2 = await prisma.honorSession.create({ data: { eventId: siteEventId, locationId: siteA.id, name: "Sunday", normalizedName: "sunday", sortOrder: 1 } });
  const classX = (await createHonorOffering(siteEventId, offeringInput([knots], sab2.id), adminId)).offerings.find((offering) => offering.sessionId === sab2.id)!;
  await createHonorOffering(siteEventId, offeringInput([knots], sun2.id), adminId);
  // X teaches Knots on Sabbath, Y teaches Knots on Sunday; X becomes "Birds, Sunday".
  await updateHonorOffering(siteEventId, classX.id, { honorIds: [birds], sessionId: sun2.id }, adminId);
  const xRows = await joinRows(classX.id);
  assert(xRows.length === 1 && xRows[0]!.honorId === birds && xRows[0]!.sessionId === sun2.id, "swapping the honor while moving to the session that already teaches the old one works");
  // Keeping an honor that another class of the session teaches is still refused, and changes nothing.
  const clash = await rejected(updateHonorOffering(siteEventId, classX.id, { honorIds: [birds, knots] }, adminId));
  assert(clash instanceof HonorConfigurationError && clash.code === "OFFERING_CONFLICT", "a real clash is refused");
  assert((await joinRows(classX.id)).length === 1, "a refused edit changes nothing");
  // Single session to all sessions, dropping an honor, at the same site.
  const classZ = (await createHonorOffering(siteEventId, offeringInput([fire, maps], sab2.id), adminId)).offerings.find((offering) => offering.honorIds.includes(fire))!;
  await updateHonorOffering(siteEventId, classZ.id, { honorIds: [maps], span: "ALL_SESSIONS", sessionId: null, locationId: siteA.id }, adminId);
  const zRows = await joinRows(classZ.id);
  assert(zRows.length === 1 && zRows[0]!.honorId === maps && zRows[0]!.sessionId === null && zRows[0]!.locationId === siteA.id, "single session to all sessions, dropping an honor");
  // A site move while swapping an honor the destination site already teaches across all sessions.
  const classU = classZ;
  const classV = (await createHonorOffering(siteEventId, { ...offeringInput([maps], sab2.id), span: "ALL_SESSIONS", sessionId: null, locationId: siteB.id }, adminId)).offerings.find((offering) => offering.locationId === siteB.id)!;
  assert(classV.id !== classU.id, "a second all-sessions class at the other site teaches maps too");
  await updateHonorOffering(siteEventId, classU.id, { honorIds: [rope], locationId: siteB.id }, adminId);
  const uRows = await joinRows(classU.id);
  assert(uRows.length === 1 && uRows[0]!.honorId === rope && uRows[0]!.locationId === siteB.id, "a site move that swaps the honor the destination site already teaches works");
  console.log("ok  editing honors while moving a class (session swap, span change, site move) succeeds, and a real clash is still refused");

  // 10. A voided record no longer blocks removing the honor or deleting the class (#591): write back, refused, void, allowed.
  const gone = await prisma.honorSession.create({ data: { eventId, name: "Gone", normalizedName: "gone", sortOrder: 4 } });
  const goneClass = (await createHonorOffering(eventId, offeringInput([compass, fire], gone.id), adminId)).offerings.find((offering) => offering.sessionId === gone.id)!;
  const staffPicks = (await prisma.honorEnrollment.findMany({ where: { registrationAttendeeId: aStaff.id }, select: { offeringId: true } })).map((row) => row.offeringId);
  await setClassSelections(clubs[0], eventId, { accountId: "director-a" }, { [aStaff.id]: [...staffPicks, goneClass.id] }, now);
  await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: aStaff.id, idempotencyKey: `${P}-checkin-staff` } });
  await writeBackHonorsWeekendCompletions(eventId, adminId);
  const staffEntry = await prisma.memberHonorEntry.findFirstOrThrow({ where: { personId: aStaff.personId, honorId: compass } });
  const refusedRemoval = await rejected(updateHonorOffering(eventId, goneClass.id, { honorIds: [fire], confirmEnrolled: 1 }, adminId));
  assert(refusedRemoval instanceof HonorConfigurationError && refusedRemoval.code === "HAS_WRITTEN_BACK_COMPLETIONS"
    && refusedRemoval.message.includes("for 1 person"), "removing an honor that was written back is refused");
  const refusedDelete = await rejected(deleteHonorOffering(eventId, goneClass.id, adminId, 1));
  assert(refusedDelete instanceof HonorConfigurationError && refusedDelete.code === "HAS_WRITTEN_BACK_COMPLETIONS", "deleting a class with written-back honors is refused");
  await prisma.memberHonorEntryVoid.create({ data: { entryId: staffEntry.id, reason: "Synthetic void for verification", voidedByUserId: adminId } });
  assert(await prisma.honorWeekendCompletionLink.count({ where: { memberHonorEntryId: staffEntry.id } }) === 1, "voiding keeps the link");
  await updateHonorOffering(eventId, goneClass.id, { honorIds: [fire], confirmEnrolled: 1 }, adminId);
  assert((await joinRows(goneClass.id)).map((row) => row.honorId).join() === fire, "once the record is voided the honor can be removed");
  // Fire was written back too (its record is not voided), so the class still can't be deleted; void it and the delete goes through.
  const stillBlocked = await rejected(deleteHonorOffering(eventId, goneClass.id, adminId, 1));
  assert(stillBlocked instanceof HonorConfigurationError && stillBlocked.code === "HAS_WRITTEN_BACK_COMPLETIONS", "a record that is not voided still blocks the delete");
  const fireEntry = await prisma.memberHonorEntry.findFirstOrThrow({ where: { personId: aStaff.personId, honorId: fire, void: null }, orderBy: { seq: "desc" } });
  const fireLink = await prisma.honorWeekendCompletionLink.findFirstOrThrow({ where: { memberHonorEntryId: fireEntry.id, enrollment: { offeringId: goneClass.id } } });
  assert(fireLink, "the fire record is linked to this class");
  await prisma.memberHonorEntryVoid.create({ data: { entryId: fireEntry.id, reason: "Synthetic void for verification", voidedByUserId: adminId } });
  await deleteHonorOffering(eventId, goneClass.id, adminId, 1);
  assert(await prisma.honorOffering.count({ where: { id: goneClass.id } }) === 0, "with every record voided the class can be deleted");
  console.log("ok  written back, refused, voided, then the honor can be removed and the class deleted");

  // 11. A write-back and an honor removal at the same moment serialize: no link survives for an honor the class no longer teaches.
  const lateSession = await prisma.honorSession.create({ data: { eventId, name: "Late", normalizedName: "late", sortOrder: 5 } });
  const lateClass = (await createHonorOffering(eventId, offeringInput([rope, fire], lateSession.id), adminId)).offerings.find((offering) => offering.sessionId === lateSession.id)!;
  const pickedNow = (await prisma.honorEnrollment.findMany({ where: { registrationAttendeeId: aStaff.id }, select: { offeringId: true } })).map((row) => row.offeringId);
  await setClassSelections(clubs[0], eventId, { accountId: "director-a" }, { [aStaff.id]: [...pickedNow, lateClass.id] }, now);
  const outcomes = await Promise.allSettled([
    writeBackHonorsWeekendCompletions(eventId, adminId),
    updateHonorOffering(eventId, lateClass.id, { honorIds: [rope], confirmEnrolled: 1 }, adminId),
  ]);
  assert(outcomes[0].status === "fulfilled", "the write-back finishes");
  const removal = outcomes[1];
  if (removal.status === "rejected") {
    assert(removal.reason instanceof HonorConfigurationError && removal.reason.code === "HAS_WRITTEN_BACK_COMPLETIONS", `a removal that loses is refused as written back, got ${String(removal.reason)}`);
  }
  const taughtNow = (await joinRows(lateClass.id)).map((row) => row.honorId);
  const lateLinks = await prisma.honorWeekendCompletionLink.findMany({ where: { enrollment: { offeringId: lateClass.id } }, select: { honorId: true } });
  assert(lateLinks.every((link) => taughtNow.includes(link.honorId)), "no completion link names an honor the class no longer teaches");
  assert(removal.status === "rejected" ? taughtNow.length === 2 && lateLinks.length === 2 : taughtNow.join() === rope && lateLinks.length <= 1,
    "either the write-back ran first and the removal was refused, or the removal ran first and only the remaining honor was written back");
  console.log("ok  a write-back and an honor removal serialize: removal refused after the write-back, or the write-back skips the removed honor");

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
