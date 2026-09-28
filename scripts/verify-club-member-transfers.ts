/**
 * Proves club member transfers (#489) against a real PostgreSQL database,
 * where the unit tests' fake database can't: the unique indexes (one roster
 * row per person per club year, one open matched transfer per person, one
 * open request per club and typed name, one outbox row per idempotency key)
 * really hold, and the flows still work with them in place:
 *
 * - a matched request completes; the sending row is erased, the birth date
 *   moves, one Person remains, honor history follows (through the real honor
 *   queries), and attendance, reports and payments stay with the old club;
 * - an unmatched request gives the same answer and goes to staff;
 * - the registration move waits for staff, then moves the attendee and their
 *   dependent rows without repricing;
 * - a transfer back to the original club in the same club year works;
 * - duplicate notification recipients never fail a completion;
 * - both removal orders (remove then complete, complete then remove).
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:club-transfers
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());
// Outbox rows are only written, never delivered, here: a placeholder key
// turns the queueing path on so duplicate recipients are exercised.
process.env.RESEND_API_KEY ||= "verify-script-placeholder-never-sent";
process.env.ACCOUNT_EMAIL_SENDER_ADDRESS ||= "events@xfer.example.test";
// A synthetic key for this run's own sealed birth dates, when none is configured.
process.env.SECRET_ENCRYPTION_KEY ||= "verify-club-transfers-synthetic-key-not-a-secret";

const prisma = new PrismaClient();
const P = "xfer";
const clubs = { a: `${P}_club_a`, b: `${P}_club_b`, c: `${P}_club_c` };
const clubIds = Object.values(clubs);
const eventId = `${P}_event`;
const staffUserId = `${P}_staff`;
const accounts = { a: `${P}_acct_a`, b: `${P}_acct_b`, c: `${P}_acct_c` };
const now = new Date("2026-10-05T15:00:00Z");
const clubYear = "2026-27";
let sealed = "";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(error && typeof error === "object" && "code" in error && (error as { code: string }).code === code, `${message}: expected ${code}, got ${String(error)}`);
}

async function cleanup() {
  const transfers = await prisma.memberTransfer.findMany({ where: { toOrganizationId: { in: clubIds } }, select: { id: true } });
  const roster = await prisma.clubRosterMember.findMany({ where: { organizationId: { in: clubIds } }, select: { id: true } });
  const attendees = await prisma.registrationAttendee.findMany({ where: { eventId }, select: { id: true } });
  await prisma.messageOutbox.deleteMany({ where: { OR: [{ correlationId: { in: transfers.map((row) => row.id) } }, { recipientEmail: { endsWith: "@xfer.example.test" } }] } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: [...transfers, ...roster, ...attendees].map((row) => row.id) } }, { eventId }, { actorUserId: staffUserId }] },
  });
  await prisma.memberTransfer.deleteMany({ where: { toOrganizationId: { in: clubIds } } });
  await prisma.honorEnrollment.deleteMany({ where: { eventId } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.honorOffering.deleteMany({ where: { eventId } });
  await prisma.honorSession.deleteMany({ where: { eventId } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.memberHonorEntry.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.honor.deleteMany({ where: { id: `${P}_honor` } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.clubMeetingNote.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.clubMonthlyReport.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.clubDirectorGrant.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.attendeeAccount.deleteMany({ where: { id: { in: Object.values(accounts) } } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
  await prisma.organization.deleteMany({ where: { id: { in: clubIds } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
}

async function addMember(club: string, key: string, firstName: string, lastName: string, email: string | null = null) {
  await prisma.person.create({ data: { id: `${P}_${key}`, firstName, lastName, normalizedEmail: email } });
  return prisma.clubRosterMember.create({
    data: {
      id: `${P}_row_${key}_${club}`, organizationId: club, clubYear, personId: `${P}_${key}`, attendeeType: "YOUTH",
      role: "Pathfinder", classLevel: "FRIEND", gender: "FEMALE", sealedBirthDate: sealed, source: "DIRECTOR",
    },
  });
}

async function main() {
  // Imported after the environment is set, so the server env sees it.
  const repo = await import("../modules/club-transfers/repository");
  const { removeRosterMember } = await import("../modules/club-rosters/repository");
  const { listClubHonorsPage, listMemberHonorHistory } = await import("../modules/honors/member-honor-repository");
  const { getClubEventWorkspace } = await import("../modules/club-registrations/repository");
  const { sealBirthDate } = await import("../modules/club-rosters/birth-dates");
  sealed = sealBirthDate("2014-03-09");

  await cleanup();
  await prisma.organization.createMany({
    data: [
      { id: clubs.a, type: "CLUB", name: "Transfer Test Club A", normalizedName: "transfer test club a" },
      { id: clubs.b, type: "CLUB", name: "Transfer Test Club B", normalizedName: "transfer test club b" },
      { id: clubs.c, type: "CLUB", name: "Transfer Test Club C", normalizedName: "transfer test club c" },
    ],
  });
  await prisma.user.create({ data: { id: staffUserId, email: "staff@xfer.example.test", displayName: "Test Staff", globalRole: "SYSTEM_ADMIN" } });
  for (const [key, id] of Object.entries(accounts)) {
    await prisma.attendeeAccount.create({ data: { id, email: `director-${key}@xfer.example.test`, displayName: `Director ${key.toUpperCase()}`, status: "ACTIVE" } });
  }
  await prisma.clubDirectorGrant.createMany({
    data: [
      { organizationId: clubs.a, attendeeAccountId: accounts.a, role: "DIRECTOR", reason: "test", effectiveFrom: new Date("2026-01-01") },
      { organizationId: clubs.b, attendeeAccountId: accounts.b, role: "DIRECTOR", reason: "test", effectiveFrom: new Date("2026-01-01") },
      { organizationId: clubs.c, attendeeAccountId: accounts.c, role: "DIRECTOR", reason: "test", effectiveFrom: new Date("2026-01-01") },
      // Director A also deputizes at C: a duplicate recipient on any A-and-C transfer.
      { organizationId: clubs.c, attendeeAccountId: accounts.a, role: "DEPUTY", reason: "test", effectiveFrom: new Date("2026-01-01") },
    ],
  });
  const directorA = { kind: "ATTENDEE" as const, accountId: accounts.a, sessionId: "s-a" };
  const directorB = { kind: "ATTENDEE" as const, accountId: accounts.b, sessionId: "s-b" };
  const directorC = { kind: "ATTENDEE" as const, accountId: accounts.c, sessionId: "s-c" };
  const staff = { userId: staffUserId };

  // The member's guardian email is Director B's address: another duplicate recipient.
  const ada = await addMember(clubs.a, "ada", "Ada", "Testperson", "director-b@xfer.example.test");
  await prisma.honor.create({ data: { id: `${P}_honor`, code: "XFER-1", name: "Transfer Honor", normalizedName: "transfer honor" } });
  await prisma.memberHonorEntry.create({ data: { personId: ada.personId!, honorId: `${P}_honor`, status: "COMPLETED", completionDate: "2026-09-20", organizationId: clubs.a } });
  await prisma.clubMeetingNote.create({ data: { organizationId: clubs.a, meetingDate: "2026-09-27", pathfinderCount: 12 } });
  await prisma.clubMonthlyReport.create({
    data: { organizationId: clubs.a, clubYear, reportMonth: "2026-09", points: {}, honors: [], onTimePoints: 0, totalPoints: 10, signatureName: "Test", signedOn: "2026-09-30", status: "SUBMITTED" },
  });

  // Club-billed event: A and B each have a registration; Ada is on A's with an adjustment line and a class seat.
  await prisma.event.create({
    data: {
      id: eventId, slug: `${P}-event`, name: "Transfer verification camporee", startsAt: new Date("2026-11-06T15:00:00Z"),
      endsAt: new Date("2026-11-08T20:00:00Z"), isPublished: true, registrationOpensOn: "2026-09-01",
      registrationClosesOn: "2026-10-30", billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  await prisma.person.create({ data: { id: `${P}_holder`, firstName: "Test", lastName: "Holder" } });
  const regA = await prisma.registration.create({ data: { eventId, accountHolderPersonId: `${P}_holder`, confirmationCode: "XFER-A", status: "SUBMITTED", totalAmount: 75, submittedAt: now } });
  const regB = await prisma.registration.create({ data: { eventId, accountHolderPersonId: `${P}_holder`, confirmationCode: "XFER-B", status: "SUBMITTED", totalAmount: 150, submittedAt: now } });
  await prisma.clubEventRegistration.createMany({ data: [
    { eventId, organizationId: clubs.a, registrationId: regA.id },
    { eventId, organizationId: clubs.b, registrationId: regB.id },
  ] });
  const adaAttendee = await prisma.registrationAttendee.create({
    data: { eventId, registrationId: regA.id, personId: ada.personId!, attendeeType: "YOUTH", position: 0, profileSnapshot: { firstName: "Ada", lastName: "Testperson", clubRosterMemberId: ada.id } },
  });
  await prisma.registrationAdjustment.create({
    data: { eventId, registrationId: regA.id, registrationAttendeeId: adaAttendee.id, kind: "SCHOLARSHIP", amountCents: -2500, reason: "Test scholarship", createdByNameSnapshot: "Test Staff" },
  });
  await prisma.payment.create({ data: { eventId, registrationId: regA.id, amount: 20, status: "SUCCEEDED", method: "CASH" } });
  const session = await prisma.honorSession.create({ data: { eventId, name: "Sabbath", normalizedName: "sabbath" } });
  const offering = await prisma.honorOffering.create({ data: { eventId, honorId: `${P}_honor`, sessionId: session.id, span: "SINGLE_SESSION", capacity: 10, perClubLimit: 5 } });
  await prisma.honorEnrollment.create({ data: { eventId, offeringId: offering.id, registrationId: regA.id, registrationAttendeeId: adaAttendee.id, organizationId: clubs.a, consumesSeat: true } });

  // 1. A matched request (typed with odd spacing and case) goes to club A; an unmatched one answers the same way.
  const matched = await repo.requestTransfer(clubs.b, { fromOrganizationId: clubs.a, firstName: "  ada ", lastName: "TESTPERSON", reason: "Family moved closer to Club B." }, directorB, now);
  const unmatched = await repo.requestTransfer(clubs.b, { fromOrganizationId: clubs.a, firstName: "Nobody", lastName: "Here", reason: "Probe" }, directorB, now);
  assert(Object.keys(matched).join() === Object.keys(unmatched).join(), "matched and unmatched requests answer with the same shape");
  const matchedRow = await prisma.memberTransfer.findUniqueOrThrow({ where: { id: matched.transferId } });
  const unmatchedRow = await prisma.memberTransfer.findUniqueOrThrow({ where: { id: unmatched.transferId } });
  // The route queues each request's notice after the response; here it runs by hand, for both.
  await repo.queueTransferRequestNotice(matched.transferId, now);
  await repo.queueTransferRequestNotice(unmatched.transferId, now);
  assert(await prisma.messageOutbox.count({ where: { correlationId: matched.transferId, templateKey: "MEMBER_TRANSFER_STARTED" } }) === 1, "the sending club is told about a matched request");
  assert(await prisma.messageOutbox.count({ where: { correlationId: unmatched.transferId } }) === 0, "an unmatched request emails no one");
  assert(matchedRow.status === "PENDING" && matchedRow.pendingPersonId === ada.personId, "exact normalized name matched");
  assert(unmatchedRow.status === "UNMATCHED" && unmatchedRow.staffReason === "NO_MATCH" && !unmatchedRow.sendingClubVisible, "unmatched request goes to staff only");
  assert(await prisma.clubRosterMember.count({ where: { organizationId: clubs.b } }) === 0, "no receiving roster row before acceptance");
  const bView = await repo.listClubTransfers(clubs.b, directorB, now);
  assert(bView.incoming.every((row) => row.statusLabel === "Pending"), "the receiving club sees matched and unmatched both as just pending");
  const aView = await repo.listClubTransfers(clubs.a, directorA, now);
  assert(aView.outgoing.length === 1 && aView.outgoing[0]!.canAccept, "the sending club sees only the matched request");
  assert(!JSON.stringify([aView, bView]).includes(sealed), "no birth date in any club payload");
  await expectCode(repo.requestTransfer(clubs.b, { fromOrganizationId: clubs.a, firstName: "Ada", lastName: "Testperson", reason: "again" }, directorB, now), "DUPLICATE_REQUEST", "a repeat request");
  console.log("ok  request: exact-name match to the sending club, unmatched to staff, same answer, duplicate refused");

  // 2. A second club asking for the same person is routed to staff, not refused (refusing would reveal the match).
  const conflict = await repo.requestTransfer(clubs.c, { fromOrganizationId: clubs.a, firstName: "Ada", lastName: "Testperson", reason: "Also asking" }, directorC, now);
  const conflictRow = await prisma.memberTransfer.findUniqueOrThrow({ where: { id: conflict.transferId } });
  assert(conflictRow.status === "UNMATCHED" && conflictRow.staffReason === "ALREADY_PENDING", "second open request for one person goes to staff");
  // The one-open-matched-transfer-per-person index is real.
  const raw = await prisma.memberTransfer.update({ where: { id: conflict.transferId }, data: { pendingPersonId: ada.personId } }).then(() => null, (error: unknown) => error);
  assert(raw && typeof raw === "object" && (raw as { code?: string }).code === "P2002", "pendingPersonId unique index holds");
  await repo.staffCancelTransfer(conflict.transferId, "Duplicate of the Club B request.", staff, now);
  console.log("ok  a second club's request for a pending member goes to staff; the unique index holds");

  // 3. B5: a member no longer active on the sending roster can't be transferred; nothing is half-done.
  await prisma.clubRosterMember.update({ where: { id: ada.id }, data: { status: "INACTIVE" } });
  await expectCode(repo.acceptTransfer(clubs.a, matched.transferId, directorA, now), "MEMBER_NO_LONGER_ACTIVE", "accepting an inactive member");
  assert((await prisma.memberTransfer.findUniqueOrThrow({ where: { id: matched.transferId } })).status === "PENDING", "a refused completion rolls back its status guard");
  await prisma.clubRosterMember.update({ where: { id: ada.id }, data: { status: "ACTIVE" } });
  console.log("ok  completion re-checks the sending row is still active and rolls back when it isn't");

  // 4. Duplicate recipients never fail a completion, even with a colliding outbox row already there.
  const completedKey = `member-transfer:${matched.transferId}:MEMBER_TRANSFER_COMPLETED:account:${accounts.a}`;
  await prisma.messageOutbox.create({
    data: {
      templateKey: "MEMBER_TRANSFER_COMPLETED", recipientKind: "ACCOUNT", recipientEmail: "director-a@xfer.example.test", accountAttendeeId: accounts.a,
      senderNameSnapshot: "IMSDA Events", senderEmailSnapshot: "events@xfer.example.test", subjectSnapshot: "pre-existing", bodyTextSnapshot: "pre-existing",
      idempotencyKey: completedKey, correlationId: matched.transferId, status: "PENDING",
    },
  });
  const accepted = await repo.acceptTransfer(clubs.a, matched.transferId, directorA, now);
  const completedNotices = await prisma.messageOutbox.findMany({ where: { correlationId: matched.transferId, templateKey: "MEMBER_TRANSFER_COMPLETED" } });
  const emails = completedNotices.map((row) => row.recipientEmail);
  assert(new Set(emails).size === emails.length, `one notice per address, got ${emails.join(", ")}`);
  assert(completedNotices.every((row) => !row.bodyTextSnapshot.includes("Family moved") && !row.idempotencyKey.includes("@")), "no reason in bodies, no raw email in keys");
  console.log(`ok  completion with duplicate recipients succeeded; ${completedNotices.length} distinct notices, no reason in any body`);

  // 5. What moved and what stayed.
  const sendingRow = await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: ada.id } });
  assert(sendingRow.status === "REMOVED" && sendingRow.personId === null && sendingRow.sealedBirthDate === null
    && sendingRow.gender === null && sendingRow.role === "" && sendingRow.classLevel === null && !sendingRow.willingToDrive, "the sending row is erased like a removal");
  const receivingRow = await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: accepted.rosterMemberId } });
  assert(receivingRow.organizationId === clubs.b && receivingRow.personId === ada.personId && receivingRow.sealedBirthDate === sealed && receivingRow.source === "TRANSFER", "the birth date moved to the receiving row");
  assert(await prisma.person.count({ where: { id: ada.personId! } }) === 1, "one Person, no duplicate");
  const history = await listMemberHonorHistory(clubs.b, receivingRow.id);
  assert(history.history.length === 1 && history.history[0]!.recordedAtOrganizationName === "Transfer Test Club A", "honor history follows, still credited to the club that recorded it");
  assert((await listClubHonorsPage(clubs.a, clubYear)).length === 0 && (await listClubHonorsPage(clubs.b, clubYear)).length === 1, "club honors pages follow the member");
  assert(await prisma.clubMeetingNote.count({ where: { organizationId: clubs.a } }) === 1 && await prisma.clubMonthlyReport.count({ where: { organizationId: clubs.a } }) === 1, "attendance and reports stay with the old club");
  const pendingMove = await prisma.memberTransferRegistrationMove.findFirstOrThrow({ where: { transferId: matched.transferId } });
  assert(pendingMove.status === "PENDING" && (await prisma.registrationAttendee.findUniqueOrThrow({ where: { id: adaAttendee.id } })).registrationId === regA.id, "nothing moved on completion; a move waits for staff");
  console.log("ok  sending row erased, birth date moved, one Person, honors follow, attendance and reports stay, registration waits");

  // 6. Every blocker is checked for real, then an approved move takes the attendee and dependents, never repricing.
  const blockedAs = async (blocker: string, message: string) => {
    const error = await repo.approveRegistrationMove(pendingMove.id, "", staff, now).then(() => null, (caught: unknown) => caught);
    assert(error && typeof error === "object" && (error as { blocker?: string }).blocker === blocker, `${message}: expected ${blocker}, got ${String(error)}`);
    assert((await prisma.memberTransferRegistrationMove.findUniqueOrThrow({ where: { id: pendingMove.id } })).status === "PENDING", `${message}: the move stays pending`);
  };
  await prisma.registration.update({ where: { id: regB.id }, data: { status: "DRAFT" } });
  await blockedAs("DESTINATION_DRAFT", "a draft destination");
  await prisma.registration.update({ where: { id: regB.id }, data: { status: "SUBMITTED" } });
  // Money guards, the same as a staff adjustment's: Ada carries a -$25 scholarship.
  await prisma.registration.update({ where: { id: regB.id }, data: { totalAmount: 0 } });
  await blockedAs("TOTAL_CLAMPED", "a destination total at $0 (maybe clamped)");
  await prisma.registration.update({ where: { id: regB.id }, data: { totalAmount: 150 } });
  const bigPayment = await prisma.payment.create({ data: { eventId, registrationId: regB.id, amount: 140, status: "SUCCEEDED", method: "CASH" } });
  await blockedAs("TOTAL_BELOW_PAID", "a destination left below what it was paid ($125 < $140)");
  await prisma.payment.delete({ where: { id: bigPayment.id } });
  const scholarship = await prisma.registrationAdjustment.findFirstOrThrow({ where: { registrationAttendeeId: adaAttendee.id } });
  await prisma.registrationAdjustment.update({ where: { id: scholarship.id }, data: { amountCents: 20000 } });
  await blockedAs("TOTAL_BELOW_ZERO", "moving a +$200 line off a $75 registration");
  await prisma.registrationAdjustment.update({ where: { id: scholarship.id }, data: { amountCents: -2500 } });
  // Club B already has a youth in Ada's class, which allows one per club.
  await prisma.person.create({ data: { id: `${P}_bea`, firstName: "Bea", lastName: "Testperson" } });
  const bea = await prisma.registrationAttendee.create({
    data: { eventId, registrationId: regB.id, personId: `${P}_bea`, attendeeType: "YOUTH", position: 0, profileSnapshot: { firstName: "Bea", lastName: "Testperson" } },
  });
  const beaSeat = await prisma.honorEnrollment.create({ data: { eventId, offeringId: offering.id, registrationId: regB.id, registrationAttendeeId: bea.id, organizationId: clubs.b, consumesSeat: true } });
  await prisma.honorOffering.update({ where: { id: offering.id }, data: { perClubLimit: 1 } });
  await blockedAs("CLUB_CLASS_LIMIT", "a class seat over the new club's per-club limit");
  await prisma.honorEnrollment.delete({ where: { id: beaSeat.id } });
  await prisma.honorOffering.update({ where: { id: offering.id }, data: { perClubLimit: 5 } });
  console.log("ok  refused: draft destination, clamped total, below paid, below $0, per-club class limit; each left the move pending");

  const moved = await repo.approveRegistrationMove(pendingMove.id, "Approved in test", staff, now);
  const attendeeAfter = await prisma.registrationAttendee.findUniqueOrThrow({ where: { id: adaAttendee.id } });
  const enrollment = await prisma.honorEnrollment.findFirstOrThrow({ where: { registrationAttendeeId: adaAttendee.id } });
  const adjustment = await prisma.registrationAdjustment.findFirstOrThrow({ where: { registrationAttendeeId: adaAttendee.id } });
  assert(attendeeAfter.registrationId === regB.id && enrollment.registrationId === regB.id && enrollment.organizationId === clubs.b && adjustment.registrationId === regB.id, "attendee, class seat and adjustment moved together");
  assert((attendeeAfter.profileSnapshot as { clubRosterMemberId?: string }).clubRosterMemberId === accepted.rosterMemberId, "the snapshot points at the receiving roster row");
  const bWorkspace = await getClubEventWorkspace(clubs.b, eventId, now);
  const adaOnB = bWorkspace.registration?.attendees.find((row) => row.attendeeId === adaAttendee.id);
  assert(adaOnB && adaOnB.offRoster === false && adaOnB.clubRosterMemberId === accepted.rosterMemberId, "the receiving club's registration shows her on its roster");
  const [aAfter, bAfter] = await Promise.all([prisma.registration.findUniqueOrThrow({ where: { id: regA.id } }), prisma.registration.findUniqueOrThrow({ where: { id: regB.id } })]);
  assert(Number(aAfter.totalAmount) === 100 && Number(bAfter.totalAmount) === 125, `totals shift only by the moved line: A ${aAfter.totalAmount}, B ${bAfter.totalAmount}`);
  assert(moved.fromTotalCentsBefore === 7500 && moved.toTotalCentsAfter === 12500, "the move reports both totals");
  assert(await prisma.payment.count({ where: { registrationId: regA.id } }) === 1, "the payment stays with the old club's registration");
  assert(await prisma.auditLog.count({ where: { action: "CLUB_MEMBER_TRANSFER_REGISTRATION_MOVE_APPROVED", actorUserId: staffUserId } }) === 1, "the approval is audited with the actor");
  console.log("ok  approved move took attendee, seat and adjustment; snapshot re-pointed, on-roster at the new club; payment stayed");

  // 7. Transfer back to club A in the same club year.
  const back = await repo.requestTransfer(clubs.a, { fromOrganizationId: clubs.b, firstName: "Ada", lastName: "Testperson", reason: "Moved back." }, directorA, now);
  const backAccepted = await repo.acceptTransfer(clubs.b, back.transferId, directorB, now);
  const backRow = await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: backAccepted.rosterMemberId } });
  assert(backRow.organizationId === clubs.a && backRow.personId === ada.personId && backRow.sealedBirthDate === sealed, "back at club A with the birth date");
  assert(await prisma.clubRosterMember.count({ where: { personId: ada.personId, status: { not: "REMOVED" } } }) === 1, "exactly one live roster row");
  // Transferring back queued a move of Ada's Club B registration back to Club A.
  const backMove = await prisma.memberTransferRegistrationMove.findFirstOrThrow({ where: { transferId: back.transferId } });
  assert(backMove.status === "PENDING" && backMove.fromRegistrationId === regB.id, "the transfer back queued her Club B registration");
  // Stale: she's no longer active at Club A, so the move is refused.
  await prisma.clubRosterMember.update({ where: { id: backRow.id }, data: { status: "INACTIVE" } });
  await expectCode(repo.approveRegistrationMove(backMove.id, "", staff, now), "MOVE_BLOCKED", "a move to a club she's no longer active at");
  const staleError = await repo.approveRegistrationMove(backMove.id, "", staff, now).then(() => null, (caught: unknown) => caught);
  assert((staleError as { blocker?: string }).blocker === "MEMBER_LEFT_RECEIVING_CLUB", "blocked as MEMBER_LEFT_RECEIVING_CLUB");
  await prisma.clubRosterMember.update({ where: { id: backRow.id }, data: { status: "ACTIVE" } });
  // A later transfer for the same person completes: the older pending move is skipped automatically, and audited.
  const again = await repo.requestTransfer(clubs.b, { fromOrganizationId: clubs.a, firstName: "Ada", lastName: "Testperson", reason: "Moved again." }, directorB, now);
  await repo.acceptTransfer(clubs.a, again.transferId, directorA, now);
  const superseded = await prisma.memberTransferRegistrationMove.findUniqueOrThrow({ where: { id: backMove.id } });
  assert(superseded.status === "SKIPPED" && superseded.note.includes("later transfer"), "the older pending move was skipped automatically");
  const autoSkipAudit = await prisma.auditLog.findFirst({ where: { action: "CLUB_MEMBER_TRANSFER_REGISTRATION_MOVE_SKIPPED", entityId: adaAttendee.id } });
  assert(autoSkipAudit && (autoSkipAudit.metadata as { automatic?: boolean; actorAttendeeAccountId?: string }).automatic === true
    && (autoSkipAudit.metadata as { actorAttendeeAccountId?: string }).actorAttendeeAccountId === accounts.a, "the automatic skip is audited with the actor");
  console.log("ok  transfer back works; a stale move is refused; a later transfer skips the older pending move, audited");

  // 8. Complete, then remove: the receiving club's removal still deletes the Person and blanks the transfer's names.
  const quinn = await addMember(clubs.a, "quinn", "Quinn", "Testperson");
  const q = await repo.requestTransfer(clubs.c, { fromOrganizationId: clubs.a, firstName: "Quinn", lastName: "Testperson", reason: "Moving." }, directorC, now);
  const qDone = await repo.acceptTransfer(clubs.a, q.transferId, directorA, now).then(
    () => { throw new Error("FAILED: Director A also leads Club C and must not self-acknowledge"); },
    (error: unknown) => error,
  );
  assert(qDone && typeof qDone === "object" && (qDone as { code?: string }).code === "SELF_ACKNOWLEDGE_NOT_ALLOWED", "N6: no self-acknowledgment");
  await expectCode(repo.staffFinishTransfer(q.transferId, "", staff, now), "NOT_OVERDUE", "finishing before 14 days");
  const later = new Date(now.getTime() + 15 * 24 * 3_600_000);
  const qFinished = await repo.staffFinishTransfer(q.transferId, "Finished after 14 days", staff, later);
  const qNotices = await prisma.messageOutbox.findMany({ where: { correlationId: q.transferId, templateKey: "MEMBER_TRANSFER_COMPLETED" } });
  assert(new Set(qNotices.map((row) => row.recipientEmail)).size === qNotices.length, "Director A (leader of both clubs) gets one notice");
  await removeRosterMember(clubs.c, qFinished.rosterMemberId, { accountId: accounts.c }, later);
  assert(await prisma.person.count({ where: { id: quinn.personId! } }) === 0, "the Person is deleted once nothing else refers to it");
  const qTransfer = await prisma.memberTransfer.findUniqueOrThrow({ where: { id: q.transferId } });
  assert(qTransfer.personId === null && qTransfer.requestedFirstName === "" && qTransfer.requestedLastName === ""
    && qTransfer.reason === "" && qTransfer.staffNote === "", "the transfer keeps no personId, name, reason or staff note after erasure");
  assert(await prisma.memberTransferEvent.count({ where: { transferId: q.transferId, note: { not: "" } } }) === 0, "no event note survives erasure");
  const cView = await repo.listClubTransfers(clubs.c, directorC, later);
  const qCard = cView.incoming.find((row) => row.id === q.transferId);
  assert(qCard && qCard.memberName === "Request closed" && qCard.reason === "", "the receiving club sees a neutral 'Request closed'");
  const qAudit = await prisma.auditLog.findFirst({ where: { action: "CLUB_MEMBER_TRANSFER_STAFF_FINISHED", entityId: q.transferId } });
  assert(qAudit && !JSON.stringify(qAudit.metadata).includes("Finished after 14 days"), "the staff note is kept out of audit metadata");
  console.log("ok  complete then remove: Person deleted, transfer record keeps clubs and dates but no name");

  // 9. Remove, then complete: the pending transfer can't complete, and the receiving club can cancel it.
  const rosa = await addMember(clubs.a, "rosa", "Rosa", "Testperson");
  const r = await repo.requestTransfer(clubs.b, { fromOrganizationId: clubs.a, firstName: "Rosa", lastName: "Testperson", reason: "Moving." }, directorB, later);
  await removeRosterMember(clubs.a, rosa.id, { accountId: accounts.a }, later);
  assert(await prisma.person.count({ where: { id: rosa.personId! } }) === 0, "removal still deletes the Person with a pending transfer on file");
  await expectCode(repo.acceptTransfer(clubs.a, r.transferId, directorA, later), "MEMBER_NO_LONGER_ACTIVE", "accepting after removal");
  await repo.cancelTransferByClub(clubs.b, r.transferId, "", directorB, later);
  assert((await prisma.memberTransfer.findUniqueOrThrow({ where: { id: r.transferId } })).status === "CANCELLED", "the receiving club cancelled it");
  console.log("ok  remove then complete: refused cleanly; the receiving club cancels");

  // 10. Staff override an unmatched request by choosing the sending member; the note is required.
  const sam = await addMember(clubs.a, "sam", "Samuel", "Testperson");
  const s = await repo.requestTransfer(clubs.b, { fromOrganizationId: clubs.a, firstName: "Sam", lastName: "Testperson", reason: "Nickname." }, directorB, later);
  await expectCode(repo.staffOverrideTransfer(s.transferId, { note: "Club confirmed by phone." }, staff, later), "MEMBER_CHOICE_REQUIRED", "override of an unmatched request without a member");
  await expectCode(repo.staffOverrideTransfer(s.transferId, { note: " ", fromRosterMemberId: sam.id }, staff, later), "REASON_REQUIRED", "override without a note");
  await repo.staffOverrideTransfer(s.transferId, { note: "Club confirmed by phone.", fromRosterMemberId: sam.id }, staff, later);
  assert((await prisma.clubRosterMember.findUniqueOrThrow({ where: { id: sam.id } })).status === "REMOVED", "overridden: the sending row is erased");
  console.log("ok  staff override of an unmatched request with a chosen member and a required note");

  await cleanup();
  console.log("club member transfer checks passed");
}

main()
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    const { getPrisma } = await import("../lib/prisma");
    await getPrisma().$disconnect();
  });
