/**
 * Check-in desk concurrency (#825): 2-4 devices (often one staff account)
 * scanning at the same moment, against a real PostgreSQL database.
 *
 *  - 4 devices check in the SAME attendee with four different retry keys:
 *    exactly one check-in row and one audit entry, three "already checked in
 *    ... by <name>" answers, never an error.
 *  - 4 devices send the SAME retry key (a timed-out scan re-sent): still one
 *    row and one audit, the rest are idempotent replays.
 *  - 4 devices check in DIFFERENT attendees of one registration: four rows,
 *    four audits, no conflict.
 *  - Check-in racing undo, and two undos at once, over many rounds: at most
 *    one active row ever, audit entries add up to the rows' final states.
 *  - The live-list delta reports the final states.
 *
 *   npm run test:check-in-concurrency   (local database only; fictitious rows it creates and removes)
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import {
  CheckInOperationError,
  checkInAttendee,
  undoCheckIn,
} from "../modules/checkin/repository";
import { listCheckInChanges } from "../modules/checkin/live-repository";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run the check-in concurrency check");

const prisma = new PrismaClient();
const key = randomUUID().replaceAll("-", "").slice(0, 10);
const eventId = `cinconc_${key}`;
const staffNames = ["Dana Desk", "Evan Desk", "Faith Desk", "Gina Desk"];
const staffIds = staffNames.map((_, index) => `cinconc_user_${index}_${key}`);
const checkedInAudits = (attendeeId: string) => prisma.auditLog.count({ where: { eventId, entityId: attendeeId, action: "ATTENDEE_CHECKED_IN" } });
const undoneAudits = (attendeeId: string) => prisma.auditLog.count({ where: { eventId, entityId: attendeeId, action: "ATTENDEE_CHECK_IN_UNDONE" } });
const activeRows = (attendeeId: string) => prisma.checkIn.count({ where: { eventId, registrationAttendeeId: attendeeId, undoneAt: null } });
const allRows = (attendeeId: string) => prisma.checkIn.count({ where: { eventId, registrationAttendeeId: attendeeId } });

async function makeRegistration(tag: string, attendees: number) {
  const person = await prisma.person.create({ data: { firstName: `Tag${tag}`, lastName: `Conc${key}`, normalizedEmail: `${tag}.${key}@checkin.example.test` } });
  const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: person.id, confirmationCode: `CC-${tag}${key}`.toUpperCase(), status: "CONFIRMED", totalAmount: 0, submittedAt: new Date() } });
  const ids: string[] = [];
  for (let position = 0; position < attendees; position += 1) {
    const member = position === 0 ? person : await prisma.person.create({ data: { firstName: `Tag${tag}${position}`, lastName: `Conc${key}`, normalizedEmail: `${tag}${position}.${key}@checkin.example.test` } });
    const attendee = await prisma.registrationAttendee.create({
      data: { eventId, registrationId: registration.id, personId: member.id, attendeeType: "adult", position, profileSnapshot: { firstName: member.firstName, lastName: member.lastName }, formResponses: {} },
    });
    ids.push(attendee.id);
  }
  return ids;
}

function settle<T>(promises: Promise<T>[]) {
  return Promise.allSettled(promises);
}

async function main() {
  for (const [index, id] of staffIds.entries()) {
    await prisma.user.create({ data: { id, email: `desk${index}.${key}@checkin.example.test`, displayName: staffNames[index] } });
  }
  await prisma.event.create({
    data: { id: eventId, slug: `cinconc-${key}`, name: "Check-in concurrency check", startsAt: new Date("2027-06-15T15:00:00Z"), endsAt: new Date("2027-06-19T15:00:00Z"), timezone: "America/Chicago", isPublished: true },
  });
  const startedAt = new Date(Date.now() - 1_000);

  // 1. Four devices, one attendee, four different retry keys.
  const [solo] = await makeRegistration("solo", 1);
  const sameAttendee = await settle(staffIds.map((id) => checkInAttendee(eventId, solo, id, randomUUID())));
  assert.ok(sameAttendee.every((r) => r.status === "fulfilled"), `no device sees an error: ${JSON.stringify(sameAttendee.filter((r) => r.status === "rejected"))}`);
  const same = sameAttendee.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof checkInAttendee>>>).value);
  assert.equal(same.filter((r) => r.disposition === "CREATED").length, 1, "exactly one device creates the check-in");
  assert.equal(same.filter((r) => r.disposition === "ALREADY_CHECKED_IN").length, 3, "the other three are told it is already done");
  assert.ok(same.every((r) => r.checkedIn), "every device ends up confirmed");
  assert.equal(new Set(same.map((r) => r.checkIn.id)).size, 1, "all four devices see the same check-in record");
  assert.equal(await activeRows(solo), 1);
  assert.equal(await allRows(solo), 1, "no duplicate row");
  assert.equal(await checkedInAudits(solo), 1, "one audit entry");
  const winnerName = staffNames[staffIds.indexOf((await prisma.auditLog.findFirstOrThrow({ where: { eventId, entityId: solo, action: "ATTENDEE_CHECKED_IN" } })).actorUserId!)];
  for (const loser of same.filter((r) => r.disposition === "ALREADY_CHECKED_IN")) {
    assert.equal(loser.checkedInBy, winnerName, "the friendly message can name who checked them in");
  }

  // 2. A scan that timed out and was re-sent: the same key, four times at once.
  const [retried] = await makeRegistration("retry", 1);
  const retryKey = randomUUID();
  const resent = await settle(Array.from({ length: 4 }, (_, index) => checkInAttendee(eventId, retried, staffIds[index % 1], retryKey)));
  assert.ok(resent.every((r) => r.status === "fulfilled"), `re-sent scans never error: ${JSON.stringify(resent.filter((r) => r.status === "rejected"))}`);
  const resentValues = resent.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof checkInAttendee>>>).value);
  assert.equal(resentValues.filter((r) => r.disposition === "CREATED").length, 1);
  assert.ok(resentValues.every((r) => r.checkedIn && r.checkIn.idempotencyKey === retryKey));
  assert.equal(await allRows(retried), 1);
  assert.equal(await checkedInAudits(retried), 1);
  // And a later re-send, long after, is still a quiet replay.
  const later = await checkInAttendee(eventId, retried, staffIds[0], retryKey);
  assert.equal(later.disposition, "IDEMPOTENT_REPLAY");
  assert.equal(await checkedInAudits(retried), 1);
  // A key may never be reused for someone else.
  await assert.rejects(checkInAttendee(eventId, solo, staffIds[0], retryKey), (error) => error instanceof CheckInOperationError && error.code === "IDEMPOTENCY_KEY_REUSED");

  // 3. Four devices, four different attendees of one registration.
  const family = await makeRegistration("family", 4);
  const different = await settle(family.map((attendeeId, index) => checkInAttendee(eventId, attendeeId, staffIds[index], randomUUID())));
  assert.ok(different.every((r) => r.status === "fulfilled"), `different attendees never conflict: ${JSON.stringify(different.filter((r) => r.status === "rejected"))}`);
  assert.ok(different.every((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof checkInAttendee>>>).value.disposition === "CREATED"));
  for (const attendeeId of family) {
    assert.equal(await activeRows(attendeeId), 1);
    assert.equal(await checkedInAudits(attendeeId), 1);
  }

  // 4. Check-in racing undo, and two undos at once, over many rounds.
  const rounds = await makeRegistration("rounds", 12);
  for (const [round, attendeeId] of rounds.entries()) {
    let created = 0;
    let undone = 0;
    if (round % 3 !== 2) {
      await checkInAttendee(eventId, attendeeId, staffIds[0], randomUUID());
      created += 1;
    }
    const checkIns = round % 3 === 1 ? 1 : 2;
    const undos = round % 3 === 1 ? 2 : 1;
    type Outcome = { kind: "in" | "out"; counted: boolean };
    const jobs: Array<Promise<Outcome>> = [
      ...Array.from({ length: checkIns }, (_, index) => checkInAttendee(eventId, attendeeId, staffIds[index], randomUUID()).then((r): Outcome => ({ kind: "in", counted: r.disposition === "CREATED" }))),
      ...Array.from({ length: undos }, (_, index) => undoCheckIn(eventId, attendeeId, staffIds[2 + index]).then((r): Outcome => ({ kind: "out", counted: r !== null }))),
    ];
    for (const outcome of await settle(jobs)) {
      assert.equal(outcome.status, "fulfilled", `round ${round}: no 500s (${outcome.status === "rejected" ? String(outcome.reason) : ""})`);
      const value = (outcome as PromiseFulfilledResult<Outcome>).value;
      if (value.counted) {
        if (value.kind === "in") created += 1;
        else undone += 1;
      }
    }
    const active = await activeRows(attendeeId);
    assert.ok(active <= 1, `round ${round}: never two active rows (${active})`);
    assert.equal(await allRows(attendeeId), created, `round ${round}: one row per created check-in`);
    assert.equal(await checkedInAudits(attendeeId), created, `round ${round}: one check-in audit per row`);
    assert.equal(await undoneAudits(attendeeId), undone, `round ${round}: one undo audit per real undo`);
    assert.equal(active, created - undone, `round ${round}: rows left active = created - undone`);
  }

  // 5. Two devices undo at once: exactly one undo.
  const [twice] = await makeRegistration("twice", 1);
  await checkInAttendee(eventId, twice, staffIds[0], randomUUID());
  const undoResults = await settle([undoCheckIn(eventId, twice, staffIds[1]), undoCheckIn(eventId, twice, staffIds[2]), undoCheckIn(eventId, twice, staffIds[3])]);
  assert.ok(undoResults.every((r) => r.status === "fulfilled"));
  assert.equal(undoResults.filter((r) => r.status === "fulfilled" && r.value !== null).length, 1, "only one undo takes effect");
  assert.equal(await undoneAudits(twice), 1);
  assert.equal(await activeRows(twice), 0);
  // The undone attendee can be checked in again, with the old key refusing to resurrect.
  const again = await checkInAttendee(eventId, twice, staffIds[0], randomUUID());
  assert.equal(again.disposition, "CREATED");

  // 6. The live list's delta shows final states, small.
  const changes = await listCheckInChanges(eventId, startedAt);
  const byId = new Map(changes.changes);
  assert.ok(byId.get(solo), "solo is checked in");
  assert.ok(family.every((id) => byId.get(id)), "the whole family is checked in");
  assert.ok(byId.get(twice), "re-checked-in attendee is active");
  assert.ok(changes.changes.every(([, at]) => at === null || !Number.isNaN(Date.parse(at))));
  assert.deepEqual((await listCheckInChanges(eventId, new Date(Date.now() + 60_000))).changes, [], "a quiet poll returns nothing");

  console.log("Check-in concurrency checks passed.");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    await prisma.event.deleteMany({ where: { id: eventId } });
    await prisma.person.deleteMany({ where: { lastName: { contains: key } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: staffIds } }, { eventId }] } });
    await prisma.user.deleteMany({ where: { id: { in: staffIds } } });
    await prisma.$disconnect();
  });
