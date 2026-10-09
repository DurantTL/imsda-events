/**
 * Proves Honors Weekend class instructors (#833) against a real PostgreSQL
 * database: the migration's tables and CHECKs; staff invite and assign; the
 * invited person accepts only with the invite's verified email; an instructor
 * reads and marks only the classes assigned to them and gets name and club
 * only (nothing from the registration's answers, contact, health, guardian or
 * birth-date fields reaches them); another instructor's class, an unassigned
 * class, another event's class and an unknown class all look the same (not
 * assigned); a Sterling Volunteers check that isn't current blocks a roster
 * and its marks; one-click and per-person marks; Completed also marks
 * attended and writes the honor record through the existing write-back (once,
 * even under races), attributed to the instructor's account; a recorded
 * completion is locked for the instructor and staff can void it; the edit
 * window closes 14 days after the event ends; removing an instructor ends
 * their access; marks are audited with ids and counts only. Uses fictitious
 * rows it creates and removes itself.
 *
 *   npm run test:honor-instructors
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { matchableName } from "../modules/background-checks/domain";
import { clubYearFor } from "../modules/club-rosters/domain";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "hins";
const staffUserId = `${P}_staff`;
const clubId = `${P}_club`;
const honorIds = { a: `${P}_honor_a`, b: `${P}_honor_b`, c: `${P}_honor_c` };
const eventId = `${P}_event`;
const otherEventId = `${P}_event_other`;
const uploadId = `${P}_upload`;
const startsWithP = { startsWith: `${P}_` };
const DAY = 24 * 60 * 60 * 1000;
const clubYear = clubYearFor(new Date());

/** Strings planted in fields an instructor must never receive. */
const secrets = {
  email: "planted-secret-email@example.test",
  birth: "2011-03-04",
  guardian: "PlantedGuardianName",
  health: "PlantedPeanutAllergyNote",
  phone: "555-0100-planted",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(error && typeof error === "object" && "code" in error && (error as { code: string }).code === code, `${message}: expected ${code}, got ${String(error)}`);
}

async function cleanup() {
  const enrollments = await prisma.honorEnrollment.findMany({ where: { eventId: startsWithP }, select: { id: true } });
  await prisma.honorWeekendCompletionLink.deleteMany({ where: { enrollmentId: { in: enrollments.map((row) => row.id) } } });
  await prisma.checkIn.deleteMany({ where: { eventId: startsWithP } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: startsWithP }, { actorUserId: staffUserId }, { metadata: { path: ["eventId"], string_starts_with: `${P}_` } }] } });
  await prisma.honorEnrollment.deleteMany({ where: { eventId: startsWithP } });
  await prisma.registrationAttendee.deleteMany({ where: { eventId: startsWithP } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: startsWithP } });
  await prisma.registration.deleteMany({ where: { eventId: startsWithP } });
  await prisma.honorInstructor.deleteMany({ where: { eventId: startsWithP } });
  await prisma.honorOffering.deleteMany({ where: { eventId: startsWithP } });
  await prisma.honorSession.deleteMany({ where: { eventId: startsWithP } });
  await prisma.event.deleteMany({ where: { id: startsWithP } });
  await prisma.backgroundCheckUpload.deleteMany({ where: { id: uploadId } });
  await prisma.memberHonorEntry.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.honor.deleteMany({ where: { id: startsWithP } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.attendeeAccount.deleteMany({ where: { id: startsWithP } });
  await prisma.person.deleteMany({ where: { OR: [{ id: startsWithP }, { normalizedEmail: { startsWith: `${P}-` } }] } });
  await prisma.organization.deleteMany({ where: { id: startsWithP } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

async function addEvent(id: string, startsAt: Date, endsAt: Date) {
  await prisma.event.create({
    data: {
      id, slug: `${id}-slug`, name: `Instructor check ${id}`, startsAt, endsAt, isPublished: true, registrationOpensOn: "2026-01-01",
      registrationClosesOn: "2026-02-01", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
}

async function main() {
  const repo = await import("../modules/honors/instructor-repository");
  const { writeBackHonorsWeekendCompletions } = await import("../modules/honors/weekend-completion-repository");
  const { voidMemberHonorEntryAsStaff } = await import("../modules/honors/member-honor-repository");

  await cleanup();
  const now = new Date();
  // The event ended two days ago: marks are open for another 12 days.
  const startsAt = new Date(now.getTime() - 3 * DAY);
  const endsAt = new Date(now.getTime() - 2 * DAY);
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Instructor Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.create({ data: { id: clubId, type: "CLUB", name: "Instructor Check Club", normalizedName: "instructor check club" } });
  await prisma.honor.createMany({ data: Object.values(honorIds).map((id) => ({ id, code: id.toUpperCase(), name: `Instructor Check ${id}`, normalizedName: `instructor check ${id}` })) });
  await addEvent(eventId, startsAt, endsAt);
  await addEvent(otherEventId, startsAt, endsAt);

  const holder = await prisma.person.create({ data: { id: `${P}_holder`, firstName: "Holder", lastName: "Sample" } });
  const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: holder.id, confirmationCode: `${P.toUpperCase()}-1`, status: "SUBMITTED", totalAmount: 0 } });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubId, registrationId: registration.id } });
  const otherRegistration = await prisma.registration.create({ data: { eventId: otherEventId, accountHolderPersonId: holder.id, confirmationCode: `${P.toUpperCase()}-2`, status: "SUBMITTED", totalAmount: 0 } });
  await prisma.clubEventRegistration.create({ data: { eventId: otherEventId, organizationId: clubId, registrationId: otherRegistration.id } });
  const session = await prisma.honorSession.create({ data: { eventId, name: "Sabbath afternoon", normalizedName: "sabbath afternoon" } });
  const otherSession = await prisma.honorSession.create({ data: { eventId: otherEventId, name: "Sunday", normalizedName: "sunday" } });
  const makeOffering = (honorId: string, sessionId: string, event = eventId) =>
    prisma.honorOffering.create({ data: { eventId: event, honorId, sessionId, span: "SINGLE_SESSION", capacity: 20, location: "Room 1" }, select: { id: true } });
  const o1 = await makeOffering(honorIds.a, session.id);
  const o2 = await makeOffering(honorIds.b, session.id);
  const o3 = await makeOffering(honorIds.c, session.id);
  const o4 = await makeOffering(honorIds.a, otherSession.id, otherEventId);

  let position = 0;
  /** A youth enrolled in a class, with sensitive data planted in every place the registration keeps it. */
  async function enroll(key: string, offeringId: string, options: { rosterMember?: boolean; checkedIn?: boolean; event?: string } = {}) {
    const event = options.event ?? eventId;
    const reg = event === eventId ? registration : otherRegistration;
    const person = await prisma.person.create({
      data: { id: `${P}_person_${key}`, firstName: `Kid${key}`, lastName: "Sample", phone: secrets.phone, normalizedEmail: `${P}-kid-${key}@example.test` },
    });
    let memberId: string | undefined;
    if (options.rosterMember !== false) {
      const member = await prisma.clubRosterMember.create({
        data: { id: `${person.id}_roster`, organizationId: clubId, clubYear, personId: person.id, attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", status: "ACTIVE", source: "DIRECTOR" },
        select: { id: true },
      });
      memberId = member.id;
    }
    position += 1;
    const attendee = await prisma.registrationAttendee.create({
      data: {
        eventId: event, registrationId: reg.id, personId: person.id, attendeeType: "ATTENDEE", position,
        profileSnapshot: {
          firstName: `Kid${key}`, lastName: "Sample", ageOnEventDate: 12, email: secrets.email, birthDate: secrets.birth, phone: secrets.phone,
          guardianName: secrets.guardian, ...(memberId ? { clubRosterMemberId: memberId } : {}),
        },
        formResponses: { medical_notes: secrets.health, dietary: secrets.health, guardian: secrets.guardian },
      },
    });
    const enrollment = await prisma.honorEnrollment.create({
      data: { eventId: event, offeringId, registrationId: reg.id, registrationAttendeeId: attendee.id, organizationId: clubId, consumesSeat: true },
      select: { id: true },
    });
    if (options.checkedIn) await prisma.checkIn.create({ data: { eventId: event, registrationAttendeeId: attendee.id, idempotencyKey: `${P}-checkin-${key}` } });
    return { personId: person.id, attendeeId: attendee.id, enrollmentId: enrollment.id, memberId };
  }
  const a1 = await enroll("a1", o1.id);
  const a2 = await enroll("a2", o1.id);
  const a3 = await enroll("a3", o1.id, { rosterMember: false });
  const b1 = await enroll("b1", o2.id);
  const c1 = await enroll("c1", o3.id);
  const d1 = await enroll("d1", o4.id, { event: otherEventId });
  // Checked in, no instructor mark: the staff write-back completes them as it always has.
  const e1 = await enroll("e1", o3.id, { checkedIn: true });

  const accountA = await prisma.attendeeAccount.create({ data: { id: `${P}_acct_a`, email: `${P}-ina@example.test`, displayName: "Ina A", status: "ACTIVE", emailVerifiedAt: new Date() }, select: { id: true, email: true } });
  const accountB = await prisma.attendeeAccount.create({ data: { id: `${P}_acct_b`, email: `${P}-ben@example.test`, displayName: "Ben B", status: "ACTIVE", emailVerifiedAt: new Date() }, select: { id: true, email: true } });
  const accountC = await prisma.attendeeAccount.create({ data: { id: `${P}_acct_c`, email: `${P}-cal@example.test`, displayName: "Cal C", status: "ACTIVE", emailVerifiedAt: new Date() }, select: { id: true, email: true } });

  // ---------------------------------------------------------------- the migration's own rules
  const refused = (work: Promise<unknown>) => work.then(() => false, () => true);
  assert(await refused(prisma.honorEnrollmentMark.create({ data: { enrollmentId: c1.enrollmentId, attended: false, completed: true } })), "the database refuses a completed mark that isn't attended");
  assert(await prisma.honorEnrollmentMark.count({ where: { enrollmentId: c1.enrollmentId } }) === 0, "and writes nothing");
  assert(await refused(prisma.honorInstructor.create({ data: { eventId, personId: holder.id, email: "Upper@Example.test", name: "Upper Case" } })), "the database refuses a mixed-case email");
  console.log("ok  the database refuses a completed mark without attended and an unnormalized instructor email");

  // ---------------------------------------------------------------- staff invite and assign
  const invitedA = await repo.inviteHonorInstructor(eventId, { firstName: "Ina", lastName: "Instructora", email: accountA.email, offeringIds: [o1.id] }, staffUserId);
  const invitedB = await repo.inviteHonorInstructor(eventId, { firstName: "Ben", lastName: "Instructorb", email: accountB.email, offeringIds: [o2.id] }, staffUserId);
  await repo.inviteHonorInstructor(eventId, { firstName: "Cal", lastName: "Instructorc", email: accountC.email, offeringIds: [o3.id] }, staffUserId);
  const listed = await repo.listHonorInstructors(eventId);
  assert(listed.instructors.length === 3 && listed.instructors.every((row) => row.status === "INVITED"), "three invited instructors");
  assert(listed.classes.length === 3, "the staff list offers this event's classes only");
  const personA = await prisma.person.findUniqueOrThrow({ where: { normalizedEmail: accountA.email } });
  assert(await prisma.honorInstructor.count({ where: { id: invitedA.instructorId, personId: personA.id } }) === 1, "the invite found or made the person by email");
  await expectCode(repo.inviteHonorInstructor(eventId, { firstName: "X", lastName: "Y", email: `${P}-x@example.test`, offeringIds: [o4.id] }, staffUserId), "CLASS_NOT_FOUND", "a class of another event");
  await expectCode(repo.inviteHonorInstructor(eventId, { firstName: "X", lastName: "Y", email: `${P}-x@example.test`, offeringIds: [] }, staffUserId), "INVALID_INSTRUCTOR", "no classes");
  assert(await prisma.honorInstructor.count({ where: { eventId, email: `${P}-x@example.test` } }) === 0, "a refused invite writes nothing");
  assert(await prisma.auditLog.count({ where: { action: "HONOR_INSTRUCTOR_INVITED", actorUserId: staffUserId } }) === 3, "each invite is audited");
  console.log("ok  staff invite and assign; classes of another event and empty selections are refused");

  // ---------------------------------------------------------------- accepting
  assert((await repo.listInstructorInvitesForAccount(accountA.email, now)).length === 1, "Ina sees her one open invite");
  await expectCode(repo.getInstructorRoster(accountA.id, o1.id, now), "NOT_ASSIGNED", "a roster before accepting");
  await expectCode(repo.acceptInstructorInvite(invitedA.instructorId, { id: accountB.id, verifiedEmail: accountB.email }, now), "INVITE_EMAIL_MISMATCH", "another account accepting Ina's invite");
  await expectCode(repo.acceptInstructorInvite(`${P}_nope`, { id: accountA.id, verifiedEmail: accountA.email }, now), "INVITE_NOT_FOUND", "an unknown invite");
  await repo.acceptInstructorInvite(invitedA.instructorId, { id: accountA.id, verifiedEmail: accountA.email }, now);
  await repo.acceptInstructorInvite(invitedB.instructorId, { id: accountB.id, verifiedEmail: accountB.email }, now);
  await expectCode(repo.acceptInstructorInvite(invitedA.instructorId, { id: accountA.id, verifiedEmail: accountA.email }, now), "INVITE_NOT_OPEN", "accepting twice");
  assert((await repo.listInstructorInvitesForAccount(accountA.email, now)).length === 0, "an accepted invite is no longer offered");
  console.log("ok  only the invited verified email accepts, once");

  // ---------------------------------------------------------------- Sterling Volunteers gate
  await prisma.backgroundCheckUpload.create({ data: { id: uploadId, format: "STERLING", rowCount: 2, added: 2, changed: 0, dropped: 0, uploadedByUserId: staffUserId } });
  const future = new Date(now.getTime() + 200 * DAY).toISOString().slice(0, 10);
  const past = new Date(now.getTime() - 30 * DAY).toISOString().slice(0, 10);
  const addEntry = (firstName: string, lastName: string, email: string, expiresOn: string, line: number) =>
    prisma.backgroundCheckEntry.create({
      data: {
        id: `${P}_entry_${line}`, uploadId, line, firstName, lastName, normalizedName: matchableName(`${firstName} ${lastName}`), email,
        identityKey: `${P}-key-${line}`, checkedOn: "2025-01-01", expiresOn,
      },
    });
  // Ben's check has expired; Ina's is current. Cal has none.
  await addEntry("Ina", "Instructora", accountA.email, future, 1);
  await addEntry("Ben", "Instructorb", accountB.email, past, 2);
  const blocked = await repo.getInstructorRoster(accountB.id, o2.id, now);
  assert(blocked.status === "STERLING_REQUIRED" && blocked.message.includes("Sterling Volunteers check"), "an expired check blocks the roster with the Sterling Volunteers message");
  assert(!JSON.stringify(blocked).includes("Kidb1"), "and no names come with the message");
  await expectCode(repo.markInstructorClass(accountB.id, o2.id, { action: "ALL_COMPLETED" }, now), "STERLING_REQUIRED", "marking without a current check");
  assert(await prisma.honorEnrollmentMark.count({ where: { enrollmentId: b1.enrollmentId } }) === 0, "a blocked mark writes nothing");
  assert((await repo.listHonorInstructors(eventId)).instructors.find((row) => row.id === invitedB.instructorId)?.sterlingCurrent === false, "staff see that Ben has no current check");
  assert((await repo.listHonorInstructors(eventId)).instructors.find((row) => row.id === invitedA.instructorId)?.sterlingCurrent === true, "and that Ina does");
  await prisma.backgroundCheckEntry.update({ where: { id: `${P}_entry_2` }, data: { expiresOn: future } });
  // The match is cached or found at read time; the answer follows the list either way.
  const unblocked = await repo.getInstructorRoster(accountB.id, o2.id, now);
  assert(unblocked.status === "OK" && unblocked.rows.length === 1, "once the check is current Ben sees his one-person roster");
  await prisma.backgroundCheckEntry.update({ where: { id: `${P}_entry_2` }, data: { expiresOn: past } });
  console.log("ok  a check that isn't current blocks the roster and marks with a clear message; a current one doesn't");

  // ---------------------------------------------------------------- scoping: own classes, name and club only
  const roster = await repo.getInstructorRoster(accountA.id, o1.id, now);
  assert(roster.status === "OK", "Ina's roster opens");
  assert(roster.rows.length === 3, "Ina sees the three people in her class");
  const keys = ["attended", "clubName", "completed", "enrollmentId", "firstName", "lastName", "recorded", "recordedVoided"];
  assert(roster.rows.every((row) => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(keys)), "every row has exactly the allowed fields");
  const serialized = JSON.stringify(roster);
  for (const [name, secret] of Object.entries(secrets)) assert(!serialized.includes(secret), `no planted ${name} reaches the instructor`);
  assert(!serialized.includes(a1.personId) && !serialized.includes(a1.attendeeId) && !serialized.includes(registration.id), "no person, attendee or registration id reaches the instructor");
  assert(roster.rows.every((row) => row.clubName === "Instructor Check Club"), "the club's name is shown");
  assert(!serialized.includes(holder.firstName), "the registration holder's name isn't on it");

  for (const other of [o2.id, o3.id, o4.id, `${P}_nope`]) {
    await expectCode(repo.getInstructorRoster(accountA.id, other, now), "NOT_ASSIGNED", `Ina reading class ${other}`);
    await expectCode(repo.markInstructorClass(accountA.id, other, { action: "ALL_COMPLETED" }, now), "NOT_ASSIGNED", `Ina marking class ${other}`);
  }
  await expectCode(repo.markInstructorClass(accountA.id, o1.id, { action: "SET", enrollmentId: b1.enrollmentId, completed: true }, now), "ENROLLMENT_NOT_FOUND", "a person from another class");
  await expectCode(repo.getInstructorRoster(accountC.id, o3.id, now), "NOT_ASSIGNED", "an invited but not accepted instructor");
  await expectCode(repo.getInstructorRoster(`${P}_nobody`, o1.id, now), "NOT_ASSIGNED", "an account that isn't an instructor");
  // A class assigned across events never counts: the instructor row belongs to one event.
  const stray = await prisma.honorInstructorClass.create({ data: { instructorId: invitedA.instructorId, offeringId: o4.id } });
  await expectCode(repo.getInstructorRoster(accountA.id, o4.id, now), "NOT_ASSIGNED", "a class of another event assigned by mistake");
  await prisma.honorInstructorClass.delete({ where: { id: stray.id } });
  assert(await prisma.honorEnrollmentMark.count({ where: { enrollmentId: { in: [b1.enrollmentId, c1.enrollmentId, d1.enrollmentId] } } }) === 0, "no refused call changed another class");
  const classes = await repo.listInstructorClasses(accountA.id, now);
  assert(classes.classes.length === 1 && classes.classes[0]?.offeringId === o1.id && classes.sterlingCurrent === true, "her class list is her one class");
  assert(!JSON.stringify(classes).includes("Kid"), "and holds no person's name");
  console.log("ok  an instructor reads and marks only their own class, with name and club only, and every other class looks alike");

  // ---------------------------------------------------------------- one-click and per-person marks; write-back
  const attended = await repo.markInstructorClass(accountA.id, o1.id, { action: "ALL_ATTENDED" }, now);
  assert(attended.changed === 3 && attended.view.rows.every((row) => row.attended && !row.completed), "all attended marks everyone attended, not completed");
  assert(attended.writeBack === null && await prisma.memberHonorEntry.count({ where: { organizationId: clubId } }) === 0, "attended alone writes no honor record");
  const one = await repo.markInstructorClass(accountA.id, o1.id, { action: "SET", enrollmentId: a1.enrollmentId, completed: true }, now);
  assert(one.view.rows.find((row) => row.enrollmentId === a1.enrollmentId)?.completed === true, "one person completed");
  const entries = await prisma.memberHonorEntry.findMany({ where: { personId: a1.personId, honorId: honorIds.a } });
  assert(entries.length === 1 && entries[0]?.status === "COMPLETED" && entries[0].recordedByAccountId === accountA.id && entries[0].recordedByUserId === null, "completing wrote the honor record, attributed to the instructor's account");
  assert(one.view.rows.find((row) => row.enrollmentId === a1.enrollmentId)?.recorded === true, "and the row says it is recorded");
  assert(await prisma.honorWeekendCompletionLink.count({ where: { enrollmentId: a1.enrollmentId } }) === 1, "through the existing write-back's link");
  assert(await prisma.auditLog.count({ where: { action: "HONORS_WEEKEND_COMPLETION_WRITTEN", entityId: entries[0]!.id } }) === 1, "the write is audited");

  // Completed also marks attended, even where attended was never marked.
  const fresh = await repo.markInstructorClass(accountA.id, o1.id, { action: "CLEAR" }, now);
  assert(fresh.locked === 1, "clear leaves the recorded completion alone and says so");
  assert(fresh.view.rows.filter((row) => !row.completed && !row.attended).length === 2, "and clears the other two");
  const viaComplete = await repo.markInstructorClass(accountA.id, o1.id, { action: "SET", enrollmentId: a2.enrollmentId, completed: true }, now);
  assert(viaComplete.view.rows.find((row) => row.enrollmentId === a2.enrollmentId)?.attended === true, "completed also marks attended");
  await expectCode(repo.markInstructorClass(accountA.id, o1.id, { action: "SET", enrollmentId: a1.enrollmentId, completed: false }, now), "MARK_LOCKED", "un-completing a recorded completion");
  await expectCode(repo.markInstructorClass(accountA.id, o1.id, { action: "SET", enrollmentId: a1.enrollmentId, attended: false }, now), "MARK_LOCKED", "un-attending a recorded completion");

  // Everyone completed, concurrently: one record per person and honor, and a person with no roster member is skipped.
  const both = await Promise.allSettled([
    repo.markInstructorClass(accountA.id, o1.id, { action: "ALL_COMPLETED" }, now),
    repo.markInstructorClass(accountA.id, o1.id, { action: "ALL_COMPLETED" }, now),
  ]);
  assert(both.every((result) => result.status === "fulfilled"), `racing one-click completions both succeed: ${JSON.stringify(both.filter((r) => r.status === "rejected"))}`);
  for (const person of [a1, a2]) {
    assert(await prisma.memberHonorEntry.count({ where: { personId: person.personId, honorId: honorIds.a } }) === 1, "exactly one honor record per person and honor, however the marks raced");
  }
  assert(await prisma.memberHonorEntry.count({ where: { personId: a3.personId } }) === 0, "a person with no club roster record has nothing to write to");
  const afterAll = await repo.getInstructorRoster(accountA.id, o1.id, now);
  assert(afterAll.status === "OK" && afterAll.rows.every((row) => row.completed && row.attended), "everyone shows completed and attended");
  assert(afterAll.rows.find((row) => row.enrollmentId === a3.enrollmentId)?.recorded === false, "the person with no roster record shows not recorded");

  // Staff can void a recorded completion; it stays locked for the instructor and is not re-created.
  await voidMemberHonorEntryAsStaff(entries[0]!.id, "Marked completed by mistake", staffUserId);
  const voided = await repo.getInstructorRoster(accountA.id, o1.id, now);
  assert(voided.status === "OK" && voided.rows.find((row) => row.enrollmentId === a1.enrollmentId)?.recordedVoided === true, "a staff void shows on the row");
  await repo.markInstructorClass(accountA.id, o1.id, { action: "ALL_COMPLETED" }, now);
  assert(await prisma.memberHonorEntry.count({ where: { personId: a1.personId, honorId: honorIds.a } }) === 1, "the voided completion is not written again");
  console.log("ok  one-click and per-person marks; Completed also marks attended and writes the honor record once; staff can void");

  // ---------------------------------------------------------------- interplay with the staff write-back
  const staffRun = await writeBackHonorsWeekendCompletions(eventId, staffUserId);
  assert(await prisma.memberHonorEntry.count({ where: { personId: e1.personId, honorId: honorIds.c } }) === 1, `a checked-in person with no instructor mark is written by the staff run, as before: ${JSON.stringify(staffRun)}`);
  assert(await prisma.memberHonorEntry.count({ where: { personId: c1.personId } }) === 0, "and an unmarked person who wasn't checked in is not");
  // An instructor who marks someone attended only (a decision) beats the check-in default.
  const mark = await prisma.honorEnrollmentMark.create({ data: { enrollmentId: b1.enrollmentId, attended: true, completed: false } });
  await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: b1.attendeeId, idempotencyKey: `${P}-checkin-b1` } });
  await writeBackHonorsWeekendCompletions(eventId, staffUserId);
  assert(await prisma.memberHonorEntry.count({ where: { personId: b1.personId } }) === 0, "an instructor's attended-only mark keeps a checked-in person from being completed by the staff run");
  await prisma.honorEnrollmentMark.update({ where: { id: mark.id }, data: { attended: true, completed: true } });
  await writeBackHonorsWeekendCompletions(eventId, staffUserId);
  assert(await prisma.memberHonorEntry.count({ where: { personId: b1.personId, honorId: honorIds.b } }) === 1, "and a completed mark is written by the staff run too");
  console.log("ok  the staff write-back honors an instructor's decision and still completes checked-in people with no mark");

  // ---------------------------------------------------------------- the 14-day window
  const lastDay = new Date(endsAt.getTime() + 14 * DAY);
  const open = await repo.markInstructorClass(accountA.id, o1.id, { action: "ALL_ATTENDED" }, new Date(lastDay.getTime() - 1000));
  assert(open.view.header.editable, "marks are open until 14 days after the event ends");
  const late = new Date(lastDay.getTime() + 1000);
  await expectCode(repo.markInstructorClass(accountA.id, o1.id, { action: "ALL_ATTENDED" }, late), "MARKS_CLOSED", "marking after the window");
  await expectCode(repo.markInstructorClass(accountA.id, o1.id, { action: "SET", enrollmentId: a1.enrollmentId, attended: true }, late), "MARKS_CLOSED", "a per-person mark after the window");
  const readOnly = await repo.getInstructorRoster(accountA.id, o1.id, late);
  assert(readOnly.status === "OK" && readOnly.header.editable === false, "after the window the roster is read only");
  console.log("ok  marks close 14 days after the event ends; the roster stays readable");

  // ---------------------------------------------------------------- audit holds ids and counts only
  const audits = await prisma.auditLog.findMany({ where: { action: "HONOR_CLASS_MARKS_UPDATED" } });
  assert(audits.length >= 6, "each mark call is audited");
  const auditText = JSON.stringify(audits);
  assert(!auditText.includes("Kid") && !auditText.includes("Sample") && !auditText.includes(secrets.email), "audit rows hold no names");
  assert(audits.every((row) => (row.metadata as { actorAttendeeAccountId?: string }).actorAttendeeAccountId === accountA.id && row.eventId === eventId), "and name the instructor's account and the event");
  console.log("ok  marks are audited with ids and counts only");

  // ---------------------------------------------------------------- staff change classes, then remove
  await expectCode(repo.setHonorInstructorClasses(eventId, invitedA.instructorId, [o4.id], staffUserId), "CLASS_NOT_FOUND", "assigning another event's class");
  await repo.setHonorInstructorClasses(eventId, invitedA.instructorId, [o1.id, o3.id], staffUserId);
  const two = await repo.getInstructorRoster(accountA.id, o3.id, now);
  assert(two.status === "OK" && two.rows.length === 2, "a class staff add shows up");
  await repo.setHonorInstructorClasses(eventId, invitedA.instructorId, [o3.id], staffUserId);
  await expectCode(repo.getInstructorRoster(accountA.id, o1.id, now), "NOT_ASSIGNED", "a class staff took away");
  assert(await prisma.honorEnrollmentMark.count({ where: { enrollmentId: a1.enrollmentId } }) === 1, "past marks stay when a class is taken away");
  await repo.removeHonorInstructor(eventId, invitedA.instructorId, staffUserId);
  await expectCode(repo.getInstructorRoster(accountA.id, o3.id, now), "NOT_ASSIGNED", "a removed instructor");
  await expectCode(repo.markInstructorClass(accountA.id, o3.id, { action: "CLEAR" }, now), "NOT_ASSIGNED", "a removed instructor marking");
  assert((await repo.listHonorInstructors(eventId)).instructors.every((row) => row.id !== invitedA.instructorId), "a removed instructor leaves the staff list");
  await expectCode(repo.removeHonorInstructor(eventId, invitedA.instructorId, staffUserId), "INSTRUCTOR_NOT_FOUND", "removing twice");
  // Re-inviting a removed instructor brings them back, still needing to accept? No: they stay accepted.
  await repo.inviteHonorInstructor(eventId, { firstName: "Ina", lastName: "Instructora", email: accountA.email, offeringIds: [o1.id] }, staffUserId);
  assert((await repo.getInstructorRoster(accountA.id, o1.id, now)).status === "OK", "a removed instructor invited again is back on their account");
  assert(await prisma.honorInstructor.count({ where: { eventId, email: accountA.email } }) === 1, "still one row per event and email");
  console.log("ok  staff change classes and remove an instructor; access follows at once");

  console.log("Honors Weekend instructor checks passed.");
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
