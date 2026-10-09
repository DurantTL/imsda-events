/**
 * Proves the Honors Weekend schedule board rules (#834) hold on the server,
 * against a real PostgreSQL database with fictitious rows it creates and
 * removes itself:
 *
 *  - a room has a capacity, and a class can't have more seats than its room:
 *    refused when placing it, when raising its seats, and when lowering the
 *    room, and the database's own trigger refuses it too;
 *  - one active class per room per session (an all-sessions class holds the
 *    room for every session); a room must be at the class's site;
 *  - moving a class that people are enrolled in keeps its enrollments and seats
 *    (never overfills), is blocked (with the number of people) when an enrolled
 *    person already holds another class in the destination session, never
 *    changes site, and keeps the honor uniqueness rules;
 *  - races: two moves into the same room and session, a move against a club's
 *    class pick, and a room shrink against a class's seats each end valid.
 *
 *   npm run test:honor-schedule-board
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { setClassSelections } from "../modules/honors/enrollment-repository";
import { HonorConfigurationError, createHonorOffering, updateHonorOffering } from "../modules/honors/repository";
import { createHonorRoom, deleteHonorRoom, getScheduleBoard, moveHonorOffering, updateHonorRoom } from "../modules/honors/schedule-repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "schedboard";
const adminId = `${P}_admin`;
const eventId = `${P}_event`;
const clubId = `${P}_club`;
const honorIds = ["a", "b", "c", "d", "e", "f"].map((key) => `${P}_honor_${key}`);
const [hA, hB, hC, hD, hE, hF] = honorIds as [string, string, string, string, string, string];
const now = new Date("2026-10-15T15:00:00Z");
const director = { accountId: "director-a" };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

const rejected = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);

async function refusal(work: Promise<unknown>, code: string, pattern: RegExp, what: string) {
  const error = await rejected(work);
  assert(error instanceof HonorConfigurationError && error.code === code && pattern.test(error.message), `${what}: expected ${code} matching ${pattern}, got ${String(error)}`);
  return error;
}

async function cleanup() {
  await prisma.honorEnrollment.deleteMany({ where: { eventId } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId }, { actorUserId: adminId }] } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.honorOffering.deleteMany({ where: { eventId } });
  await prisma.honorSession.deleteMany({ where: { eventId } });
  await prisma.honorRoom.deleteMany({ where: { eventId } });
  await prisma.honor.deleteMany({ where: { id: { in: honorIds } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: clubId } });
  await prisma.eventLocation.deleteMany({ where: { eventId } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.organization.deleteMany({ where: { id: clubId } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.user.deleteMany({ where: { id: adminId } });
}

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: adminId, email: `${P}-admin@example.test`, displayName: "Schedule Admin", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.create({ data: { id: clubId, type: "CLUB", name: "Schedule Club", normalizedName: "schedule club" } });
  await prisma.honor.createMany({
    data: honorIds.map((id, index) => ({ id, code: `SCHED-${index}`, name: `Schedule honor ${index}`, normalizedName: `schedule honor ${index}` })),
  });
  await prisma.event.create({
    data: {
      id: eventId, slug: `${P}-event`, name: "Schedule board verification", startsAt: new Date("2026-12-05T15:00:00Z"),
      endsAt: new Date("2026-12-06T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-10-01",
      registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  const siteA = await prisma.eventLocation.create({ data: { eventId, name: "Site A", normalizedName: "site a", sortOrder: 0 } });
  const siteB = await prisma.eventLocation.create({ data: { eventId, name: "Site B", normalizedName: "site b", sortOrder: 1 } });
  const session = (name: string, locationId: string, sortOrder: number) =>
    prisma.honorSession.create({ data: { eventId, locationId, name, normalizedName: name.toLowerCase(), sortOrder } });
  const s1 = await session("One", siteA.id, 0);
  const s2 = await session("Two", siteA.id, 1);
  const s3 = await session("Three", siteA.id, 2);
  const sB = await session("Other site", siteB.id, 0);

  const cls = async (honorId: string, sessionId: string, capacity: number, extra: Record<string, unknown> = {}) => {
    const setup = await createHonorOffering(eventId, {
      honorIds: [honorId], span: "SINGLE_SESSION", sessionId, locationId: null, capacity, minimumAge: null, perClubLimit: null,
      teacherName: "Synthetic Teacher", location: "", additionalCostCents: null, requirementNote: "", isActive: true, ...extra,
    }, adminId);
    return setup.offerings.find((offering) => offering.honorIds[0] === honorId && offering.sessionId === sessionId)!;
  };
  const room = async (name: string, capacity: number, locationId: string | null) => {
    const board = await createHonorRoom(eventId, { name, capacity, locationId, sortOrder: 0 }, adminId);
    return board.rooms.find((candidate) => candidate.name === name)!;
  };
  const move = (offeringId: string, roomId: string | null, sessionId?: string) => moveHonorOffering(eventId, offeringId, { roomId, ...(sessionId ? { sessionId } : {}) }, adminId);
  const fresh = (offeringId: string) => prisma.honorOffering.findUniqueOrThrow({ where: { id: offeringId } });

  // 1. Room capacity.
  const big = await room("Big hall", 20, siteA.id);
  const small = await room("Small room", 10, siteA.id);
  const roomB = await room("Other site room", 30, siteB.id);
  await refusal(createHonorRoom(eventId, { name: "BIG  hall", capacity: 5, locationId: siteA.id, sortOrder: 0 }, adminId), "ROOM_NAME_CONFLICT", /already has a room/, "a duplicate room name at a site");
  await createHonorRoom(eventId, { name: "Big hall", capacity: 5, locationId: siteB.id, sortOrder: 0 }, adminId);
  await refusal(createHonorRoom(eventId, { name: "No site", capacity: 5, locationId: null, sortOrder: 0 }, adminId), "LOCATION_REQUIRED", /Choose the site/, "a room with no site when the event has sites");
  const c1 = await cls(hA, s1.id, 20);
  const c2 = await cls(hB, s1.id, 10);
  const c3 = await cls(hC, s2.id, 10);
  const c4 = await cls(hA, s2.id, 20);
  console.log("ok  rooms: names are unique per site, a site is required");

  await move(c1.id, big.id);
  assert((await fresh(c1.id)).roomId === big.id && (await fresh(c1.id)).location === "Big hall", "the class is in the room, and its free-text room mirrors the name");
  await refusal(move(c1.id, small.id), "ROOM_TOO_SMALL", /seats 10, and this class has 20/, "a class bigger than the room");
  await refusal(updateHonorOffering(eventId, c1.id, { capacity: 21 }, adminId), "ROOM_TOO_SMALL", /seats 20/, "raising a class's seats above its room");
  await updateHonorOffering(eventId, c1.id, { capacity: 20 }, adminId);
  await refusal(updateHonorRoom(eventId, big.id, { capacity: 15 }, adminId), "ROOM_TOO_SMALL", /more than 15 seats/, "shrinking a room under a class");
  const direct = await rejected(prisma.honorOffering.update({ where: { id: c1.id }, data: { capacity: 25 } }));
  assert(direct !== null && /room capacity/.test(String(direct)), "the database itself refuses a class over its room's seats");
  const directRoom = await rejected(prisma.honorRoom.update({ where: { id: big.id }, data: { capacity: 3 } }));
  assert(directRoom !== null && /below a class/.test(String(directRoom)), "the database itself refuses shrinking a room under a class");
  await updateHonorRoom(eventId, big.id, { capacity: 25 }, adminId);
  await updateHonorOffering(eventId, c1.id, { capacity: 25 }, adminId);
  await refusal(deleteHonorRoom(eventId, big.id, adminId), "ROOM_IN_USE", /1 class placed in it/, "removing a room with a class in it");
  await updateHonorOffering(eventId, c1.id, { capacity: 20 }, adminId);
  await updateHonorRoom(eventId, big.id, { name: "Main hall" }, adminId);
  assert((await fresh(c1.id)).location === "Main hall", "renaming a room renames the class's room text");
  console.log("ok  room capacity: a class never has more seats than its room (app and database), and a room can't shrink under one");

  // 2. One class per room per session; site; all-sessions.
  await refusal(move(c2.id, big.id), "ROOM_BOOKED", /already has/, "two classes in one room and session");
  await move(c2.id, small.id);
  await refusal(move(c2.id, roomB.id), "ROOM_WRONG_SITE", /different site/, "a room at another site");
  await move(c3.id, big.id);
  assert((await fresh(c3.id)).roomId === big.id, "the same room in another session is fine");
  const allSessions = await createHonorOffering(eventId, {
    honorIds: [hD], span: "ALL_SESSIONS", sessionId: null, locationId: siteA.id, capacity: 8, minimumAge: null, perClubLimit: null,
    teacherName: "", location: "", additionalCostCents: null, requirementNote: "", isActive: true,
  }, adminId);
  const all = allSessions.offerings.find((offering) => offering.span === "ALL_SESSIONS")!;
  await refusal(move(all.id, big.id), "ROOM_BOOKED", /already has/, "an all-sessions class into a room used in some session");
  const hall3 = await room("Third room", 25, siteA.id);
  await move(all.id, hall3.id);
  await refusal(move(c4.id, hall3.id), "ROOM_BOOKED", /already has/, "a class into a room an all-sessions class holds");
  await refusal(moveHonorOffering(eventId, all.id, { roomId: hall3.id, sessionId: s1.id }, adminId), "MOVE_INVALID", /isn't tied to one session/, "moving an all-sessions class to a session");
  await move(c3.id, null);
  assert((await fresh(c3.id)).roomId === null && (await fresh(c3.id)).location === "", "taking a class out of its room clears it");
  await move(c3.id, big.id);
  console.log("ok  placement: one active class per room and session, an all-sessions class holds the room, the room must be at the site");

  // 3. Moves of classes that have enrollments.
  const holder = await prisma.person.create({ data: { id: `${P}_holder`, firstName: "Test", lastName: "Director" } });
  const registration = await prisma.registration.create({
    data: { eventId, accountHolderPersonId: holder.id, confirmationCode: `REG-${P}`, status: "SUBMITTED", totalAmount: 0, submittedAt: now, locationId: siteA.id },
  });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubId, registrationId: registration.id } });
  const attendees: string[] = [];
  const addPerson = async (key: string, type: "YOUTH" | "STAFF" = "YOUTH") => {
    const person = await prisma.person.create({ data: { id: `${P}_${key}`, firstName: "Test", lastName: key } });
    const member = await prisma.clubRosterMember.create({ data: { organizationId: clubId, clubYear: "2026-27", personId: person.id, attendeeType: type, classLevel: "GUIDE", source: "DIRECTOR" } });
    const attendee = await prisma.registrationAttendee.create({
      data: {
        eventId, registrationId: registration.id, personId: person.id, attendeeType: type, position: attendees.length,
        profileSnapshot: { firstName: "Test", lastName: key, ageOnEventDate: 13, clubRosterMemberId: member.id },
      },
    });
    attendees.push(attendee.id);
    return attendee.id;
  };
  const p1 = await addPerson("p1");
  const p2 = await addPerson("p2");
  const p3 = await addPerson("p3");
  const staff = await addPerson("staff", "STAFF");
  const pick = (attendeeId: string, ...classIds: string[]) => setClassSelections(clubId, eventId, director, { [attendeeId]: classIds }, now);
  // c1 (session One, honor A): p1, p2, staff. c3 (session Two, honor C): p1. c2 (One, honor B, room small): p1 is not in it; p3 also holds c3.
  await pick(p1, c1.id, c3.id);
  await pick(p2, c1.id);
  await pick(staff, c1.id);
  await pick(p3, c2.id, c3.id);
  const before = await prisma.honorEnrollment.findMany({ where: { offeringId: c1.id }, select: { id: true, consumesSeat: true }, orderBy: { id: "asc" } });
  assert(before.length === 3, "three people are enrolled in the first class");

  const blocked = await refusal(move(c2.id, null, s2.id), "MOVE_HAS_CONFLICTS", /1 enrolled person already holds another class/, "moving into a session where an enrolled person has another class");
  assert(blocked.details?.conflicts === 1, "the refusal carries the number of people in conflict");
  const stuck = await fresh(c2.id);
  assert(stuck.sessionId === s1.id && stuck.roomId === small.id, "a blocked move changes nothing");
  assert((await prisma.honorEnrollment.count({ where: { offeringId: c2.id } })) === 1, "a blocked move leaves the enrollment alone");
  await refusal(move(c1.id, null, sB.id), "OFFERING_HAS_PICKS", /can't move to another site/, "moving enrolled clubs' class to another site");
  await refusal(move(c4.id, hall3.id), "ROOM_BOOKED", /already has/, "(sanity) the all-sessions room is still held");
  // c4 teaches honor A in session Two; c1 (honor A) may not join it.
  const slot = await refusal(moveHonorOffering(eventId, c1.id, { roomId: null, sessionId: s2.id }, adminId), "OFFERING_CONFLICT", /./, "the same honor twice in one session");
  assert(slot.code === "OFFERING_CONFLICT", "honor uniqueness is checked before the people check");
  console.log("ok  enrolled move: blocked with the conflict count, changes nothing, never changes site, keeps honor uniqueness");

  // A free session: moves with all enrollments intact and no overfill.
  const moved = await move(c1.id, big.id, s3.id);
  const after = await prisma.honorEnrollment.findMany({ where: { offeringId: c1.id }, select: { id: true, consumesSeat: true }, orderBy: { id: "asc" } });
  assert(JSON.stringify(after) === JSON.stringify(before), "every enrollment (and its seat flag) is unchanged by the move");
  const movedCard = moved.cards.find((card) => card.id === c1.id)!;
  assert(movedCard.sessionId === s3.id && movedCard.seatsTaken === 2 && movedCard.enrolled === 3 && movedCard.capacity === 20, "the board shows the class in its new session with the same seats (staff take none)");
  for (const card of moved.cards) assert(card.seatsTaken <= card.capacity, `no class is overfilled (${card.title})`);
  for (const card of moved.cards.filter((candidate) => candidate.roomId)) {
    assert(card.capacity <= moved.rooms.find((candidate) => candidate.id === card.roomId)!.capacity, "every placed class fits its room");
  }
  const audit = await prisma.auditLog.findFirst({ where: { eventId, action: "HONOR_OFFERING_MOVED", entityId: c1.id }, orderBy: { createdAt: "desc" } });
  assert(audit && /Moved .* to Three/.test(audit.summary) && JSON.stringify(audit.metadata).includes('"enrolled":3'), "the move is audited");
  console.log("ok  enrolled move to a free session: enrollments and seats unchanged, nobody overfilled, audited");

  // No person holds two classes in one session after any of this.
  const perSession = await prisma.honorEnrollment.findMany({ where: { eventId }, select: { registrationAttendeeId: true, offering: { select: { sessionId: true } } } });
  const seen = new Set<string>();
  for (const row of perSession) {
    const key = `${row.registrationAttendeeId}:${row.offering.sessionId}`;
    assert(!seen.has(key), "nobody holds two classes in one session");
    seen.add(key);
  }

  // 4. Races.
  // 4a. Two moves into the same room and session: exactly one wins.
  const r1 = await room("Race room", 30, siteA.id);
  const x = await cls(hE, s1.id, 5);
  const y = await cls(hF, s1.id, 5);
  const raced = await Promise.allSettled([move(x.id, r1.id), move(y.id, r1.id)]);
  assert(raced.filter((result) => result.status === "fulfilled").length === 1, "exactly one of two moves into the same room and session wins");
  assert((await prisma.honorOffering.count({ where: { roomId: r1.id, sessionId: s1.id } })) === 1, "the room holds one class in the session");
  console.log("ok  race: two classes into one room and session, one wins");

  // 4b. A move against a club's pick: never both (nobody ends in two classes in one session).
  let blockedByMove = 0;
  let blockedByPick = 0;
  for (let round = 0; round < 6; round += 1) {
    const from = await session(`Race from ${round}`, siteA.id, 10 + round * 2);
    const to = await session(`Race to ${round}`, siteA.id, 11 + round * 2);
    const moving = await cls(hA, from.id, 10);
    const target = await cls(hB, to.id, 10);
    const racer = await addPerson(`racer${round}`);
    await pick(racer, moving.id);
    const [moveResult, pickResult] = await Promise.allSettled([move(moving.id, null, to.id), pick(racer, moving.id, target.id)]);
    const rows = await prisma.honorEnrollment.findMany({ where: { registrationAttendeeId: racer }, select: { offering: { select: { sessionId: true } } } });
    const sessions = rows.map((row) => row.offering.sessionId);
    assert(new Set(sessions).size === sessions.length, `round ${round}: nobody holds two classes in one session after a move races a pick`);
    assert(!(moveResult.status === "fulfilled" && pickResult.status === "fulfilled"), `round ${round}: a move into a session and a pick there can't both succeed`);
    if (moveResult.status === "rejected") blockedByPick += 1;
    if (pickResult.status === "rejected") blockedByMove += 1;
  }
  console.log(`ok  race: a move against a club pick always ends valid (move refused ${blockedByPick}x, pick refused ${blockedByMove}x)`);

  // 4c. A room shrink against a class raising its seats: the class always fits its room.
  for (let round = 0; round < 4; round += 1) {
    const rs = await session(`Shrink ${round}`, siteA.id, 40 + round);
    const rm = await room(`Shrink room ${round}`, 20, siteA.id);
    const k = await cls(hA, rs.id, 10);
    await move(k.id, rm.id);
    await Promise.allSettled([updateHonorRoom(eventId, rm.id, { capacity: 12 }, adminId), updateHonorOffering(eventId, k.id, { capacity: 18 }, adminId)]);
    const [roomRow, classRow] = await Promise.all([prisma.honorRoom.findUniqueOrThrow({ where: { id: rm.id } }), fresh(k.id)]);
    assert(classRow.capacity <= roomRow.capacity, `round ${round}: the class (${classRow.capacity}) fits its room (${roomRow.capacity})`);
  }
  console.log("ok  race: shrinking a room against raising a class's seats always leaves the class within its room");

  const board = await getScheduleBoard(eventId);
  assert(board.rooms.length > 0 && board.cards.every((card) => card.instructors.length === 0), "without instructor data (#833) cards carry no instructors");

  await cleanup();
  console.log("Honor schedule board checks passed.");
}

main()
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
