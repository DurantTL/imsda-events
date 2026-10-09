/**
 * Proves the Honors Weekend class level and prerequisite honor rules (#832)
 * hold on the server, against a real PostgreSQL database with fictitious rows
 * it creates and removes itself:
 *
 *  - a youth at or above a class's minimum level, with the prerequisite honors
 *    on their honor record, joins freely;
 *  - a level known to be too low is refused, whatever the director confirms;
 *  - a missing level, or a prerequisite honor with no completed record (an
 *    in-progress or voided entry doesn't count), is allowed only with the
 *    director's confirmation, and the confirmation is recorded;
 *  - only staff acting as the director may override, with a reason, and the
 *    override is recorded on the enrollment and in the audit log;
 *  - staff and adults are not asked, and a class someone already holds is
 *    never re-checked;
 *  - the catalog saves the level and prerequisites, and refuses a prerequisite
 *    the class teaches itself.
 *
 *   npm run test:honor-class-requirements
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { ClassSelectionError, getClassSelectionWorkspace, setClassSelections } from "../modules/honors/enrollment-repository";
import { HonorConfigurationError, createHonorOffering, getEventHonorSetup, updateHonorOffering } from "../modules/honors/repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "honorreq";
const adminId = `${P}_admin`;
const eventId = `${P}_event`;
const clubId = `${P}_club`;
const knots = `${P}_honor_knots`;
const birds = `${P}_honor_birds`;
const advancedKnots = `${P}_honor_advknots`;
const now = new Date("2026-10-15T15:00:00Z");
const director = { accountId: "director-a" };
const staffActing = { userId: adminId, actAsId: `${P}_actas` };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

const rejected = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);

async function cleanup() {
  await prisma.memberHonorEntry.deleteMany({ where: { honorId: { in: [knots, birds, advancedKnots] } } });
  await prisma.honorEnrollment.deleteMany({ where: { eventId } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId }, { actorUserId: adminId }] } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.honorOffering.deleteMany({ where: { eventId } });
  await prisma.honorSession.deleteMany({ where: { eventId } });
  await prisma.honor.deleteMany({ where: { id: { in: [knots, birds, advancedKnots] } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: clubId } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.organization.deleteMany({ where: { id: clubId } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.user.deleteMany({ where: { id: adminId } });
}

type Level = "FRIEND" | "RANGER" | "GUIDE" | null;

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: adminId, email: `${P}-admin@example.test`, displayName: "Requirements Admin", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.create({ data: { id: clubId, type: "CLUB", name: "Requirements Club", normalizedName: "requirements club" } });
  await prisma.honor.createMany({
    data: [[knots, "REQ-KNOTS", "Knots"], [birds, "REQ-BIRDS", "Birds"], [advancedKnots, "REQ-ADVK", "Advanced Knots"]]
      .map(([id, code, name]) => ({ id: id!, code: code!, name: `${name} (req)`, normalizedName: `${name!.toLowerCase()} req` })),
  });
  await prisma.event.create({
    data: {
      id: eventId, slug: `${P}-event`, name: "Class requirements verification", startsAt: new Date("2026-12-05T15:00:00Z"),
      endsAt: new Date("2026-12-06T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-10-01",
      registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  const sessions = await Promise.all(["One", "Two", "Three"].map((name, sortOrder) => prisma.honorSession.create({ data: { eventId, name, normalizedName: name.toLowerCase(), sortOrder } })));
  const [s1, s2, s3] = sessions as [typeof sessions[number], typeof sessions[number], typeof sessions[number]];

  // The classes are made through the staff catalog code, so its saving is checked too.
  const input = (honorIds: string[], sessionId: string, extra: Record<string, unknown> = {}) => ({
    honorIds, span: "SINGLE_SESSION" as const, sessionId, locationId: null, capacity: 20, minimumAge: null, perClubLimit: null,
    teacherName: "Synthetic Teacher", location: "Room 1", additionalCostCents: null, requirementNote: "", isActive: true, ...extra,
  });
  await createHonorOffering(eventId, input([advancedKnots], s1.id, { minimumClassLevel: "GUIDE" }), adminId);
  await createHonorOffering(eventId, input([birds], s2.id, { prerequisiteHonorIds: [knots] }), adminId);
  const setup = await createHonorOffering(eventId, input([knots], s3.id, { minimumClassLevel: "RANGER", prerequisiteHonorIds: [birds] }), adminId);
  const byLevel = (level: string) => setup.offerings.find((offering) => offering.minimumClassLevel === level)!;
  const classA = byLevel("GUIDE");
  const classC = byLevel("RANGER");
  const classB = setup.offerings.find((offering) => offering.minimumClassLevel === null && offering.prerequisiteHonorIds.includes(knots))!;
  assert(classA && classB && classC, "the catalog saved the three classes");
  assert(classC.prerequisiteHonors.map((honor) => honor.id).join() === birds, "the catalog returns the prerequisite honors");
  console.log("ok  catalog: minimum level and prerequisite honors are saved and read back");

  // The class teaches Knots (class C), so Knots can't also be its prerequisite.
  const teachesOwn = await rejected(updateHonorOffering(eventId, classC.id, { prerequisiteHonorIds: [knots] }, adminId));
  assert(teachesOwn instanceof HonorConfigurationError && /can't also be a prerequisite/.test(teachesOwn.message), "a class can't require the honor it teaches");
  const edited = await updateHonorOffering(eventId, classB.id, { minimumClassLevel: "COMPANION", prerequisiteHonorIds: [knots, advancedKnots] }, adminId);
  const editedB = edited.offerings.find((offering) => offering.id === classB.id)!;
  assert(editedB.minimumClassLevel === "COMPANION" && editedB.prerequisiteHonorIds.length === 2, "an edit replaces the level and prerequisites");
  await updateHonorOffering(eventId, classB.id, { minimumClassLevel: null, prerequisiteHonorIds: [knots] }, adminId);
  const untouched = await updateHonorOffering(eventId, classB.id, { capacity: 21 }, adminId);
  const untouchedB = untouched.offerings.find((offering) => offering.id === classB.id)!;
  assert(untouchedB.minimumClassLevel === null && untouchedB.prerequisiteHonorIds.join() === knots, "an edit that names neither leaves them alone");
  console.log("ok  catalog: editing replaces them, leaves them alone otherwise, and refuses a class's own honor");

  // The club: five youth at different levels, and a staff member.
  const holder = await prisma.person.create({ data: { id: `${P}_holder`, firstName: "Test", lastName: "Director" } });
  const registration = await prisma.registration.create({
    data: { eventId, accountHolderPersonId: holder.id, confirmationCode: `REG-${P}`, status: "SUBMITTED", totalAmount: 0, submittedAt: now },
  });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubId, registrationId: registration.id } });
  const people: Record<string, { attendeeId: string; personId: string }> = {};
  const addPerson = async (key: string, level: Level, type: "YOUTH" | "STAFF" = "YOUTH") => {
    const person = await prisma.person.create({ data: { id: `${P}_${key}`, firstName: "Test", lastName: key } });
    const member = await prisma.clubRosterMember.create({
      data: { organizationId: clubId, clubYear: "2026-27", personId: person.id, attendeeType: type, classLevel: level, source: "DIRECTOR" },
    });
    const attendee = await prisma.registrationAttendee.create({
      data: {
        eventId, registrationId: registration.id, personId: person.id, attendeeType: type, position: Object.keys(people).length,
        profileSnapshot: { firstName: "Test", lastName: key, ageOnEventDate: 13, clubRosterMemberId: member.id },
      },
    });
    people[key] = { attendeeId: attendee.id, personId: person.id };
  };
  await addPerson("gina", "GUIDE");
  await addPerson("rory", "RANGER");
  await addPerson("fay", "FRIEND");
  await addPerson("nolan", null);
  await addPerson("vera", "GUIDE");
  await addPerson("staff", null, "STAFF");
  const record = (key: string, honorId: string, status: "COMPLETED" | "IN_PROGRESS") => prisma.memberHonorEntry.create({
    data: { personId: people[key]!.personId, honorId, status, completionDate: status === "COMPLETED" ? "2026-06-01" : "", organizationId: clubId },
  });
  await record("gina", knots, "COMPLETED");
  await record("gina", birds, "COMPLETED");
  await record("rory", knots, "IN_PROGRESS");
  const voided = await record("vera", knots, "COMPLETED");
  await prisma.memberHonorEntryVoid.create({ data: { entryId: voided.id, reason: "Entered by mistake" } });
  const id = (key: string) => people[key]!.attendeeId;
  const save = (key: string, classIds: string[], waivers: Parameters<typeof setClassSelections>[5] = {}, actor: Parameters<typeof setClassSelections>[2] = director) =>
    setClassSelections(clubId, eventId, actor, { [id(key)]: classIds }, now, waivers);
  const enrollment = (key: string, offeringId: string) => prisma.honorEnrollment.findFirst({ where: { registrationAttendeeId: id(key), offeringId } });
  const refusal = async (work: Promise<unknown>, pattern: RegExp, what: string) => {
    const error = await rejected(work);
    assert(error instanceof ClassSelectionError && error.code === "SELECTION_INVALID" && pattern.test(error.message), `${what}: expected a refusal matching ${pattern}, got ${String(error)}`);
  };

  // 1. The workspace tells the picker each person's level and completed prerequisites.
  const workspace = await getClassSelectionWorkspace(clubId, eventId, now);
  const gina = workspace.attendees.find((attendee) => attendee.id === id("gina"))!;
  assert(gina.classLevel === "GUIDE" && gina.completedHonorIds.includes(knots) && gina.completedHonorIds.includes(birds), "the workspace carries Gina's level and completed honors");
  const vera = workspace.attendees.find((attendee) => attendee.id === id("vera"))!;
  assert(vera.completedHonorIds.length === 0, "a voided entry is not a completed honor");
  const rory = workspace.attendees.find((attendee) => attendee.id === id("rory"))!;
  assert(rory.completedHonorIds.length === 0, "an in-progress entry is not a completed honor");
  assert(workspace.offerings.find((offering) => offering.id === classC.id)!.prerequisiteHonors[0]?.id === birds, "the workspace names a class's prerequisites");
  console.log("ok  workspace: levels and completed honors reach the picker; voided and in-progress entries don't count");

  // 2. Meeting every rule needs no confirmation and records none.
  await setClassSelections(clubId, eventId, director, { [id("gina")]: [classA.id, classB.id, classC.id] }, now);
  for (const classId of [classA.id, classB.id, classC.id]) {
    const row = await enrollment("gina", classId);
    assert(row && !row.levelConfirmedByDirector && !row.prerequisitesConfirmedByDirector && row.requirementOverrideReason === null, "Gina met every rule, so nothing is recorded");
  }
  console.log("ok  a youth who meets the level and has the honors joins with nothing recorded");

  // 3. A level known to be too low is refused; a confirmation does not help; an attendee account can't override.
  await refusal(save("fay", [classA.id]), /class level Guide or higher, and this person is Friend/, "a Friend in a Guide class");
  await refusal(save("fay", [classA.id], { confirmations: { [id("fay")]: [classA.id] } }), /this person is Friend/, "a director cannot confirm past a known level");
  await refusal(save("fay", [classA.id], { overrides: { [id("fay")]: { [classA.id]: "Please" } } }), /Only staff/, "an attendee account cannot override");
  await refusal(save("fay", [classA.id], { overrides: { [id("fay")]: { [classA.id]: "  " } } }, staffActing), /Only staff|class level/, "staff need a real reason");
  assert((await prisma.honorEnrollment.count({ where: { registrationAttendeeId: id("fay") } })) === 0, "refused saves leave no enrollment");
  console.log("ok  a level known to be too low is refused: confirmation and attendee-account overrides don't help");

  // 4. Staff acting as the director place Fay with a reason; it is recorded and audited.
  await save("fay", [classA.id], { overrides: { [id("fay")]: { [classA.id]: "Approved by the Area Coordinator" } } }, staffActing);
  const placed = await enrollment("fay", classA.id);
  assert(placed?.requirementOverrideReason === "Approved by the Area Coordinator" && placed.requirementOverriddenByUserId === adminId, "the override and who made it are recorded");
  const audit = await prisma.auditLog.findFirst({ where: { eventId, action: "HONOR_CLASS_REQUIREMENT_OVERRIDDEN" } });
  assert(audit && audit.actorUserId === adminId && /Approved by the Area Coordinator/.test(audit.summary), "the override is in the audit log with its reason");
  // Once placed she keeps the class on later saves without asking again.
  await save("fay", [classA.id]);
  assert((await prisma.honorEnrollment.count({ where: { registrationAttendeeId: id("fay"), offeringId: classA.id } })) === 1, "an existing placement isn't re-checked or duplicated");
  console.log("ok  staff override: recorded on the enrollment, audited with the reason, and kept on later saves");

  // 5. A missing level needs the director's confirmation, and it is recorded.
  await refusal(save("nolan", [classA.id]), /class level isn't on the roster/, "a missing level");
  await save("nolan", [classA.id], { confirmations: { [id("nolan")]: [classA.id] } });
  const nolan = await enrollment("nolan", classA.id);
  assert(nolan?.levelConfirmedByDirector && !nolan.prerequisitesConfirmedByDirector && nolan.requirementOverrideReason === null, "the level confirmation is recorded");
  console.log("ok  a missing level is allowed only with the director's confirmation, which is recorded");

  // 6. A missing prerequisite honor record needs the confirmation too; the level and honor parts are recorded separately.
  await refusal(save("rory", [classB.id]), /needs .*Knots.* completed first/, "an in-progress prerequisite");
  await refusal(save("vera", [classB.id]), /needs .*Knots.* completed first/, "a voided prerequisite");
  await save("rory", [classB.id], { confirmations: { [id("rory")]: [classB.id] } });
  const roryB = await enrollment("rory", classB.id);
  assert(roryB?.prerequisitesConfirmedByDirector && !roryB.levelConfirmedByDirector, "the honor confirmation is recorded on its own");
  await refusal(save("rory", [classC.id]), /needs .*Birds.* completed first/, "Rory has the level for C but not Birds");
  await save("rory", [classC.id], { confirmations: { [id("rory")]: [classC.id] } });
  const roryC = await enrollment("rory", classC.id);
  assert(roryC?.prerequisitesConfirmedByDirector && !roryC.levelConfirmedByDirector, "Rory's level meets C, so only the honor confirmation is recorded");
  // A confirmation is per class: confirming one class doesn't cover another.
  await refusal(save("vera", [classB.id, classA.id], { confirmations: { [id("vera")]: [classA.id] } }), /Knots/, "a tick for another class");
  console.log("ok  a prerequisite honor with no completed record is allowed only with a recorded confirmation, per class");

  // 7. Staff and adults are never asked.
  await save("staff", [classA.id, classB.id, classC.id]);
  const staff = await enrollment("staff", classA.id);
  assert(staff && !staff.levelConfirmedByDirector && staff.requirementOverrideReason === null, "staff join without a check");
  console.log("ok  staff and adults are not asked for a level or prerequisites");

  // 8. The same rule runs through the club's save of several people at once: one refusal saves nobody.
  const before = await prisma.honorEnrollment.count({ where: { eventId } });
  const mixed = await rejected(setClassSelections(clubId, eventId, director, { [id("vera")]: [classA.id], [id("fay")]: [classA.id, classC.id] }, now));
  assert(mixed instanceof ClassSelectionError, "a save with one person who doesn't qualify is refused");
  assert((await prisma.honorEnrollment.count({ where: { eventId } })) === before, "and nothing from that save is kept");
  const confirmationsAudit = await prisma.auditLog.findMany({ where: { eventId, action: "HONOR_CLASSES_UPDATED" } });
  assert(confirmationsAudit.some((entry) => JSON.stringify(entry.metadata).includes("requirementsConfirmed")), "confirmations are in the class-save audit entry");
  const setupAfter = await getEventHonorSetup(eventId);
  assert(setupAfter.offerings.length === 3, "the setup still lists three classes");
  console.log("ok  one person who doesn't qualify refuses the whole save, and nothing is kept");

  await cleanup();
  console.log("Honor class requirement checks passed.");
}

main()
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
