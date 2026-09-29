/**
 * Proves the audited void of a member honor entry (#591) against a real
 * PostgreSQL database: voiding the latest entry makes the previous non-voided
 * one current (or leaves no status); Master Award progress and honor order
 * needs follow; the entry row is never changed or deleted and the void keeps
 * who, when and why; a double void (also two racing) and another club's void
 * are refused; the database itself refuses a void with a short reason or two
 * actors; and the Honors Weekend write-back never re-creates a voided
 * completion, but does record a fresh one when the only completion on file was
 * voided before the write-back ran. Uses fictitious rows it creates and
 * removes itself.
 *
 *   npm run test:honor-entry-void
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { clubYearFor } from "../modules/club-rosters/domain";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "hvoid";
const staffUserId = `${P}_staff`;
const clubs = { main: `${P}_club`, other: `${P}_club_other` };
const honors = { a: `${P}_honor_a`, b: `${P}_honor_b`, weekend: `${P}_honor_weekend` };
const items = { patch: `${P}_item_patch`, master: `${P}_item_master` };
const eventId = `${P}_event`;
const startsWithP = { startsWith: `${P}_` };
const actor = { userId: staffUserId, actAsId: `${P}_actas` };

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
  await prisma.honorEnrollment.deleteMany({ where: { eventId: startsWithP } });
  await prisma.registrationAttendee.deleteMany({ where: { eventId: startsWithP } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: startsWithP } });
  await prisma.registration.deleteMany({ where: { eventId: startsWithP } });
  await prisma.honorOffering.deleteMany({ where: { eventId: startsWithP } });
  await prisma.honorSession.deleteMany({ where: { eventId: startsWithP } });
  await prisma.event.deleteMany({ where: { id: startsWithP } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: staffUserId }, { metadata: { path: ["organizationId"], string_starts_with: `${P}_` } }] } });
  await prisma.clubOrderNeed.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.masterAwardRule.deleteMany({ where: { normalizedName: startsWithP } });
  await prisma.clubSupplyItem.deleteMany({ where: { id: startsWithP } });
  // Voids go with their entries (ON DELETE CASCADE), which only happens for a person's erasure.
  await prisma.memberHonorEntry.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.honor.deleteMany({ where: { id: startsWithP } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: startsWithP } });
  await prisma.person.deleteMany({ where: { id: startsWithP } });
  await prisma.organization.deleteMany({ where: { id: startsWithP } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

const clubYear = clubYearFor(new Date());

async function addPerson(key: string, organizationId: string) {
  const id = `${P}_person_${key}`;
  await prisma.person.create({ data: { id, firstName: key, lastName: "Sample" } });
  const member = await prisma.clubRosterMember.create({
    data: { id: `${id}_roster`, organizationId, clubYear, personId: id, attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", status: "ACTIVE", source: "DIRECTOR" },
    select: { id: true },
  });
  return { personId: id, memberId: member.id };
}

function entry(personId: string, honorId: string, status: "IN_PROGRESS" | "COMPLETED", organizationId = clubs.main) {
  return prisma.memberHonorEntry.create({
    data: { personId, honorId, status, completionDate: status === "COMPLETED" ? "2026-09-20" : "", organizationId, recordedByUserId: staffUserId },
    select: { id: true },
  });
}

async function main() {
  const { voidMemberHonorEntry, listMemberHonorHistory, listClubHonorsPage } = await import("../modules/honors/member-honor-repository");
  const { syncHonorOrderNeeds } = await import("../modules/honors/order-source");
  const { loadMasterAwardProgress } = await import("../modules/earned-awards/order-source");
  const { writeBackHonorsWeekendCompletions } = await import("../modules/honors/weekend-completion-repository");

  await cleanup();
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Void Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.organization.createMany({
    data: Object.entries(clubs).map(([key, id]) => ({ id, type: "CLUB" as const, name: `Void Check ${key} Club`, normalizedName: `void check ${key} club` })),
  });
  await prisma.honor.createMany({
    data: Object.values(honors).map((id) => ({ id, code: id.toUpperCase(), name: `Void Check ${id}`, normalizedName: `void check ${id}` })),
  });
  await prisma.clubSupplyItem.createMany({
    data: [
      { id: items.patch, section: "OUTDOOR_INDUSTRIES", name: "Void Check Patch", normalizedName: `${P} patch`, catalogNumber: "005157", honorId: honors.a },
      { id: items.master, section: "MASTER_AWARDS", name: "Void Check Master Award", normalizedName: `${P} master award`, catalogNumber: "004035" },
    ],
  });
  await prisma.masterAwardRule.create({
    data: {
      name: "Void Check Master", normalizedName: `${P} master`, itemId: items.master, status: "ACTIVE",
      groups: { create: [{ position: 1, minimum: 1, honors: { create: [{ honorId: honors.a }, { honorId: honors.b }] } }] },
    },
  });

  // ---------------------------------------------------------------- status, awards and needs follow a void
  const ada = await addPerson("ada", clubs.main);
  const started = await entry(ada.personId, honors.a, "IN_PROGRESS");
  const mistaken = await entry(ada.personId, honors.a, "COMPLETED");
  const eligible = async () => (await loadMasterAwardProgress(clubs.main))[0].eligible.map((person) => person.personId);
  assert((await eligible()).includes(ada.personId), "a COMPLETED honor makes Ada eligible for the Master Award");
  await syncHonorOrderNeeds(clubs.main);
  assert(await prisma.clubOrderNeed.count({ where: { organizationId: clubs.main, personId: ada.personId, itemId: items.patch, status: "NEEDED" } }) === 1, "the completion creates a NEEDED patch need");

  await voidMemberHonorEntry(clubs.main, ada.memberId, mistaken.id, "Marked completed by mistake", actor);
  assert(!(await eligible()).includes(ada.personId), "voiding the completion removes Ada from the award's eligible list");
  await syncHonorOrderNeeds(clubs.main);
  assert(await prisma.clubOrderNeed.count({ where: { organizationId: clubs.main, personId: ada.personId, itemId: items.patch } }) === 0, "the NEEDED patch need for the voided completion is withdrawn");
  const history = await listMemberHonorHistory(clubs.main, ada.memberId);
  assert(history.history.length === 2 && history.history[0].voided?.reason === "Marked completed by mistake", "voided entry stays in history with its reason");
  assert(history.history[0].voided?.voidedByName === "Void Check Staff", "and who voided it");
  assert(history.current.length === 1 && history.current[0].status === "IN_PROGRESS", "the previous non-voided entry (in progress) is current again");
  const page = await listClubHonorsPage(clubs.main, clubYear);
  assert(page.find((row) => row.memberId === ada.memberId)?.honors[0]?.status === "IN_PROGRESS", "the roster/Honors page shows in progress");
  assert(await prisma.memberHonorEntry.count({ where: { personId: ada.personId } }) === 2, "no entry row was deleted");
  const stored = await prisma.memberHonorEntry.findUniqueOrThrow({ where: { id: mistaken.id } });
  assert(stored.status === "COMPLETED" && stored.completionDate === "2026-09-20", "the voided entry row itself is unchanged");
  assert(await prisma.auditLog.count({ where: { action: "MEMBER_HONOR_VOIDED", entityId: mistaken.id, actorUserId: staffUserId } }) === 1, "the void is audited");
  console.log("ok  voiding the latest entry restores the previous status; awards and needs follow; history keeps who and why");

  // Void the rest: no status left.
  await voidMemberHonorEntry(clubs.main, ada.memberId, started.id, "Recorded for the wrong honor", actor);
  assert((await listMemberHonorHistory(clubs.main, ada.memberId)).current.length === 0, "with every entry voided there is no status");
  assert((await listClubHonorsPage(clubs.main, clubYear)).find((row) => row.memberId === ada.memberId)?.honors.length === 0, "and the Honors page shows none");

  // ---------------------------------------------------------------- refusals
  await expectCode(voidMemberHonorEntry(clubs.main, ada.memberId, mistaken.id, "Second time", actor), "ENTRY_ALREADY_VOIDED", "a double void");
  assert(await prisma.memberHonorEntryVoid.count({ where: { entryId: mistaken.id } }) === 1, "still one void row");
  const bo = await addPerson("bo", clubs.main);
  const raced = await entry(bo.personId, honors.b, "COMPLETED");
  const race = await Promise.allSettled([
    voidMemberHonorEntry(clubs.main, bo.memberId, raced.id, "Racing void one", actor),
    voidMemberHonorEntry(clubs.main, bo.memberId, raced.id, "Racing void two", actor),
  ]);
  assert(race.filter((result) => result.status === "fulfilled").length === 1, "of two racing voids exactly one succeeds");
  const loser = race.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert((loser.reason as { code?: string }).code === "ENTRY_ALREADY_VOIDED", "the other is refused as already voided");
  const cy = await addPerson("cy", clubs.main);
  const foreign = await entry(cy.personId, honors.b, "COMPLETED", clubs.other);
  await expectCode(voidMemberHonorEntry(clubs.main, cy.memberId, foreign.id, "Not our entry to void", actor), "VOID_NOT_ALLOWED", "another club's entry");
  await expectCode(voidMemberHonorEntry(clubs.main, cy.memberId, `${P}_nope`, "No such entry", actor), "ENTRY_NOT_FOUND", "a missing entry");
  await expectCode(voidMemberHonorEntry(clubs.main, cy.memberId, raced.id, "Someone else's entry", actor), "ENTRY_NOT_FOUND", "an entry of a different person");
  await expectCode(voidMemberHonorEntry(clubs.main, cy.memberId, foreign.id, "ab", actor), "ENTRY_INVALID", "a reason under 3 characters");
  assert(await prisma.memberHonorEntryVoid.count({ where: { entryId: foreign.id } }) === 0, "refused voids write nothing");
  // The database backs the rules up.
  const rejected = (data: { reason: string; voidedByUserId?: string | null; voidedByAccountId?: string | null }) =>
    prisma.memberHonorEntryVoid.create({ data: { entryId: foreign.id, ...data } }).then(() => false, () => true);
  assert(await rejected({ reason: "ab", voidedByUserId: staffUserId }), "the database refuses a 2-character reason");
  assert(await rejected({ reason: "x".repeat(501), voidedByUserId: staffUserId }), "the database refuses a 501-character reason");
  const account = await prisma.attendeeAccount.create({ data: { email: `${P}-acct@example.test`, displayName: "Void Check Account" } });
  assert(await rejected({ reason: "Two actors", voidedByUserId: staffUserId, voidedByAccountId: account.id }), "the database refuses two actors");
  await prisma.attendeeAccount.delete({ where: { id: account.id } });
  console.log("ok  double and racing voids, another club's entry, and bad reasons are refused; the database enforces the reason and actor rules");

  // ---------------------------------------------------------------- Honors Weekend write-back
  const sam = await addPerson("sam", clubs.main);
  const kim = await addPerson("kim", clubs.main);
  await prisma.event.create({
    data: {
      id: eventId, slug: `${P}-event`, name: "Void check Honors Weekend", startsAt: new Date("2026-12-05T15:00:00Z"),
      endsAt: new Date("2026-12-06T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-10-01",
      registrationClosesOn: "2026-11-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: sam.personId, confirmationCode: `${P.toUpperCase()}-HW`, status: "SUBMITTED", totalAmount: 0 } });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: clubs.main, registrationId: registration.id } });
  const session = await prisma.honorSession.create({ data: { eventId, name: "Sabbath afternoon", normalizedName: "sabbath afternoon" } });
  const offering = await prisma.honorOffering.create({ data: { eventId, honorId: honors.weekend, sessionId: session.id, span: "SINGLE_SESSION", capacity: 10 } });
  const enroll = async (person: { personId: string; memberId: string }, position: number) => {
    const attendee = await prisma.registrationAttendee.create({
      data: { eventId, registrationId: registration.id, personId: person.personId, attendeeType: "ATTENDEE", position, profileSnapshot: { firstName: "X", lastName: "Y", clubRosterMemberId: person.memberId } },
    });
    await prisma.honorEnrollment.create({ data: { eventId, offeringId: offering.id, registrationId: registration.id, registrationAttendeeId: attendee.id, organizationId: clubs.main, consumesSeat: true } });
    await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: attendee.id, idempotencyKey: `${P}-checkin-${position}` } });
  };
  await enroll(sam, 0);
  // Kim's only completion on file was voided before the write-back ran.
  const kimsMistake = await entry(kim.personId, honors.weekend, "COMPLETED");
  await voidMemberHonorEntry(clubs.main, kim.memberId, kimsMistake.id, "Recorded for the wrong honor", actor);
  await enroll(kim, 1);

  const first = await writeBackHonorsWeekendCompletions(eventId, staffUserId);
  assert(first.written === 2, `both are written back (a voided completion doesn't count as already recorded), got ${JSON.stringify(first)}`);
  assert(await prisma.memberHonorEntry.count({ where: { personId: kim.personId, honorId: honors.weekend } }) === 2, "Kim keeps the voided entry and gets a fresh one");
  const samEntry = await prisma.memberHonorEntry.findFirstOrThrow({ where: { personId: sam.personId, honorId: honors.weekend }, select: { id: true } });
  await voidMemberHonorEntry(clubs.main, sam.memberId, samEntry.id, "Was not actually at the class", actor);
  const again = await writeBackHonorsWeekendCompletions(eventId, staffUserId);
  assert(again.written === 0 && again.alreadyRecorded === 2, `a voided write-back is not re-created on the next run, got ${JSON.stringify(again)}`);
  assert(await prisma.memberHonorEntry.count({ where: { personId: sam.personId, honorId: honors.weekend } }) === 1, "Sam still has only the voided entry");
  assert((await listMemberHonorHistory(clubs.main, sam.memberId)).current.length === 0, "and no current status for the honor");
  console.log("ok  Honors Weekend write-back doesn't re-create a voided completion, and records a fresh one when only a voided one was on file");

  console.log("Honor entry void checks passed.");
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
