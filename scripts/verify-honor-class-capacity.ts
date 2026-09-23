/**
 * Proves Honors Weekend class seats hold under concurrent saves (#359):
 * two clubs racing for the last seat, exactly one wins. Also checks that the
 * printed class rosters (#360) count the same seats, and that a cancelled club
 * registration gives its seats back. Runs against a real
 * PostgreSQL database with fictitious rows it creates and removes itself.
 *
 *   npm run test:honor-capacity
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { ClassSelectionError, getClassSelectionWorkspace, setClassSelections } from "../modules/honors/enrollment-repository";
import { buildClassRosters } from "../modules/honors/roster-domain";
import { getHonorRosterData } from "../modules/honors/roster-repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "honorcap";
const eventId = `${P}_event`;
const clubs = [`${P}_club_a`, `${P}_club_b`];
const offeringId = `${P}_offering`;
const now = new Date("2026-10-15T15:00:00Z");

async function cleanup() {
  await prisma.honorEnrollment.deleteMany({ where: { eventId } });
  await prisma.auditLog.deleteMany({ where: { eventId } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.honorOffering.deleteMany({ where: { eventId } });
  await prisma.honorSession.deleteMany({ where: { eventId } });
  await prisma.honor.deleteMany({ where: { id: `${P}_honor` } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { in: clubs } } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.organization.deleteMany({ where: { id: { in: clubs } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
}

async function registerClub(clubId: string, people: Array<{ key: string; type: "YOUTH" | "STAFF" }>) {
  const holder = await prisma.person.create({ data: { id: `${P}_${clubId}_holder`, firstName: "Test", lastName: "Director" } });
  const registration = await prisma.registration.create({
    data: { eventId, accountHolderPersonId: holder.id, confirmationCode: `REG-${clubId}`, status: "SUBMITTED", totalAmount: 0, submittedAt: now },
  });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubId, registrationId: registration.id } });
  const attendeeIds: string[] = [];
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
    attendeeIds.push(attendee.id);
  }
  return attendeeIds;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function main() {
  await cleanup();
  await prisma.organization.createMany({
    data: clubs.map((id) => ({ id, type: "CLUB" as const, name: `Capacity ${id}`, normalizedName: `capacity ${id}` })),
  });
  await prisma.event.create({
    data: {
      id: eventId, slug: `${P}-event`, name: "Honor capacity verification", startsAt: new Date("2026-12-05T15:00:00Z"),
      endsAt: new Date("2026-12-06T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-10-01",
      registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE",
    },
  });
  const session = await prisma.honorSession.create({ data: { eventId, name: "Sabbath", normalizedName: "sabbath" } });
  await prisma.honor.create({ data: { id: `${P}_honor`, code: "CAP-001", name: "Capacity Honor", normalizedName: "capacity honor" } });
  await prisma.honorOffering.create({
    data: { id: offeringId, eventId, honorId: `${P}_honor`, sessionId: session.id, span: "SINGLE_SESSION", capacity: 1, perClubLimit: 1 },
  });
  const [a] = await registerClub(clubs[0], [{ key: "youth", type: "YOUTH" }]);
  const [b, bSecondYouth, bStaff] = await registerClub(clubs[1], [
    { key: "youth", type: "YOUTH" }, { key: "youth2", type: "YOUTH" }, { key: "staff", type: "STAFF" },
  ]);

  // 1. Two clubs race for the last seat: exactly one wins.
  const results = await Promise.allSettled([
    setClassSelections(clubs[0], eventId, "director-a", { [a]: [offeringId] }, now),
    setClassSelections(clubs[1], eventId, "director-b", { [b]: [offeringId] }, now),
  ]);
  const won = results.filter((result) => result.status === "fulfilled").length;
  const lost = results.filter((result) => result.status === "rejected");
  assert(won === 1 && lost.length === 1, `expected one winner, got ${won}`);
  const reason = (lost[0] as PromiseRejectedResult).reason;
  assert(reason instanceof ClassSelectionError && reason.code === "CLASS_FULL", `loser should see CLASS_FULL, got ${String(reason)}`);
  const seats = await prisma.honorEnrollment.count({ where: { offeringId, consumesSeat: true } });
  assert(seats === 1, `expected 1 seat taken, found ${seats}`);
  console.log("ok  last seat: one club won, the other was told the class is full");

  // 2. Staff join a full class without using a seat.
  await setClassSelections(clubs[1], eventId, "director-b", { [bStaff]: [offeringId] }, now);
  const staff = await prisma.honorEnrollment.findFirst({ where: { registrationAttendeeId: bStaff } });
  assert(staff && !staff.consumesSeat, "staff should join without a seat");
  console.log("ok  staff joined a full class without taking a seat");

  // 3. Freeing the seat lets the other club in; the per-club limit still holds.
  const winner = results[0].status === "fulfilled" ? { club: clubs[0], attendee: a } : { club: clubs[1], attendee: b };
  await setClassSelections(winner.club, eventId, "director", { [winner.attendee]: [] }, now);
  await prisma.honorOffering.update({ where: { id: offeringId }, data: { capacity: 5 } });
  await setClassSelections(clubs[1], eventId, "director-b", { [b]: [offeringId] }, now);
  const limited = await setClassSelections(clubs[1], eventId, "director-b", { [bSecondYouth]: [offeringId] }, now)
    .then(() => null, (error: unknown) => error);
  assert(limited instanceof ClassSelectionError && limited.code === "CLUB_LIMIT_REACHED", "second youth from one club should hit the per-club limit");
  console.log("ok  freed seat reused; per-club limit refused a second youth");

  // 4. The printed class roster counts exactly the seats H5 counts.
  const rosterSeats = async () => {
    const data = await getHonorRosterData(eventId, { includeDietary: false });
    assert(data, "roster data should load");
    return buildClassRosters(data.sessions, data.offerings, data.enrollments, data.attendees)
      .find((roster) => roster.offering.id === offeringId)!;
  };
  const liveSeats = async () => (await getClassSelectionWorkspace(clubs[0], eventId, now))
    .offerings.find((offering) => offering.id === offeringId)!.seatsTaken;
  const before = await rosterSeats();
  assert(before.youthSeats === (await liveSeats()) && before.youthSeats === 1, `roster ${before.youthSeats} vs live seats`);
  assert(before.people.length === 2, `class roster should list the youth and the staff member, found ${before.people.length}`);
  console.log("ok  class roster seats match live seat counts");

  // 5. Cancelling a club's registration gives its seats back, in both places.
  await prisma.registration.updateMany({ where: { eventId, confirmationCode: `REG-${clubs[1]}` }, data: { status: "CANCELLED" } });
  const after = await rosterSeats();
  assert(after.youthSeats === 0 && after.people.length === 0, "a cancelled club should leave the class roster");
  assert((await liveSeats()) === 0, "a cancelled club's seats should be free again");
  console.log("ok  cancelled registration freed its seats and left the roster");
}

main()
  .then(() => console.log("Honor class capacity verification passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
