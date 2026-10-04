/**
 * Proves attendance reconciliation (#166) against a real PostgreSQL database, where the unit
 * tests' in-memory stand-in can't:
 *
 * - preparing is blocked until billing responsibility is recorded, then bills only the people who
 *   were checked in (no-shows counted, not billed), with the #409 credit applied to the people who
 *   attended; preparing again with unchanged facts writes nothing, and parallel prepares leave
 *   one version;
 * - an approved version is immutable (the database refuses a rewrite, a delete, a reopening, and a
 *   second approved version for the event), and attendance changed after approval leaves it
 *   untouched while the view flags the change; approving a newer draft supersedes it;
 * - parallel approvals of one draft approve it once; the database lets only one of two drafts be
 *   approved at the same moment;
 * - corrections are append-only with supersede: one active per person even under parallel writes,
 *   a reason is required, rows cannot be edited or deleted, and another event's people and versions
 *   are refused;
 * - foreign-key actions still work: deleting a user clears the actor, deleting an attendee or the
 *   event removes the rows that hang off it;
 * - no audit row holds a correction's reason or a person's name.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:attendance-reconciliation
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import { resolveEventBillingResponsibility } from "@/modules/billing-responsibility/repository";
import {
  AttendanceReconciliationError,
  approveReconciliation,
  getAttendanceReconciliationView,
  prepareReconciliation,
  recordAttendanceCorrection,
} from "@/modules/attendance-reconciliation/repository";

loadEnvConfig(process.cwd());
// Local-only, before any Prisma client or connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-attendance-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = `ar166_${randomUUID().slice(0, 8)}`;
const ids = {
  staff: `${P}_staff`,
  staff2: `${P}_staff2`,
  doomed: `${P}_doomed`,
  holder: `${P}_holder`,
  church: `${P}_church`,
  club1: `${P}_club_1`,
  club2: `${P}_club_2`,
  eventA: `${P}_ev_a`,
  eventB: `${P}_ev_b`,
  form: `${P}_form`,
  formVersion: `${P}_form_v1`,
};
const REASON = "Verify reason text that must never reach an audit row";
const people = ["Ann", "Bo", "Cy", "Di", "Ed", "Flo"].map((name) => ({ id: `${P}_person_${name}`, name }));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function rejects(promise: Promise<unknown>) {
  return promise.then(() => false, () => true);
}

async function cleanup() {
  const eventIds = [ids.eventA, ids.eventB];
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: eventIds } }, { actorUserId: { in: [ids.staff, ids.staff2, ids.doomed] } }] } });
  await prisma.publicRegistrationSubmission.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ids.club1, ids.club2] } } });
  await prisma.organization.deleteMany({ where: { id: ids.church } });
  await prisma.person.deleteMany({ where: { id: { in: [ids.holder, ...people.map((entry) => entry.id)] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.staff, ids.staff2, ids.doomed] } } });
}

let registrationCounter = 0;
async function registration(eventId: string, club: string, attendeeNames: string[], submission?: { lines: unknown[]; responses: Record<string, unknown>; definition: unknown; totalCents: number }) {
  registrationCounter += 1;
  const created = await prisma.registration.create({
    data: {
      eventId,
      accountHolderPersonId: ids.holder,
      confirmationCode: `${P}-${registrationCounter}`,
      status: "CONFIRMED",
      totalAmount: ((submission?.totalCents ?? 5000) / 100).toFixed(2),
      submittedAt: new Date("2027-03-01T10:00:00Z"),
    },
    select: { id: true },
  });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: club, registrationId: created.id } });
  const attendees: Record<string, string> = {};
  for (const [position, name] of attendeeNames.entries()) {
    const person = people.find((entry) => entry.name === name)!;
    const attendee = await prisma.registrationAttendee.create({
      data: {
        eventId,
        registrationId: created.id,
        personId: person.id,
        attendeeType: "YOUTH",
        position,
        profileSnapshot: { firstName: name, lastName: "Verify" },
        createdAt: new Date("2027-03-01T10:00:00Z"),
      },
      select: { id: true },
    });
    attendees[name] = attendee.id;
  }
  if (submission) {
    await prisma.publicRegistrationSubmission.create({
      data: {
        eventId,
        formVersionId: ids.formVersion,
        registrationId: created.id,
        idempotencyKey: `${P}-${registrationCounter}`,
        requestHash: `hash-${registrationCounter}`,
        responses: submission.responses as object,
        pricingSnapshot: { lineItems: submission.lines } as object,
      },
    });
  }
  return { id: created.id, attendees };
}

const checkIn = (eventId: string, attendeeId: string) =>
  prisma.checkIn.create({ data: { eventId, registrationAttendeeId: attendeeId, idempotencyKey: `${P}-ci-${attendeeId}` } });

async function main() {
  await cleanup();
  await prisma.user.createMany({ data: [
    { id: ids.staff, email: `${P}_staff@example.test`, displayName: "Fran Finance" },
    { id: ids.staff2, email: `${P}_staff2@example.test`, displayName: "Fay Finance" },
    { id: ids.doomed, email: `${P}_doomed@example.test`, displayName: "Dee Departing" },
  ] });
  await prisma.person.createMany({ data: [
    { id: ids.holder, firstName: "Pat", lastName: "Holder" },
    ...people.map((entry) => ({ id: entry.id, firstName: entry.name, lastName: "Verify" })),
  ] });
  await prisma.organization.create({ data: { id: ids.church, type: "CHURCH", name: `Attendance Check Church ${P}`, normalizedName: `attendance check church ${P}` } });
  await prisma.organization.createMany({ data: [
    { id: ids.club1, type: "CLUB", name: `Attendance Check Club 1 ${P}`, normalizedName: `attendance check club 1 ${P}`, parentOrganizationId: ids.church },
    { id: ids.club2, type: "CLUB", name: `Attendance Check Club 2 ${P}`, normalizedName: `attendance check club 2 ${P}`, parentOrganizationId: ids.church },
  ] });
  const when = { startsAt: new Date("2027-04-01T00:00:00Z"), endsAt: new Date("2027-04-03T00:00:00Z"), audience: "CLUB" as const, billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const };
  await prisma.event.create({ data: { id: ids.eventA, slug: `${P}-a`, name: "Synthetic Camporee A", ...when } });
  await prisma.event.create({ data: { id: ids.eventB, slug: `${P}-b`, name: "Synthetic Camporee B", ...when } });
  const definition = { sections: [{ fields: [{ key: "meal_sponsorship_count", creditCentsPerUnit: -500, capUnitsAtAttendeeCount: true }] }] };
  await prisma.registrationForm.create({ data: { id: ids.form, eventId: ids.eventA, createdByUserId: ids.staff, name: "Synthetic form", slug: `${P}-form` } });
  await prisma.registrationFormVersion.create({ data: { id: ids.formVersion, formId: ids.form, createdByUserId: ids.staff, versionNumber: 1, definition } });

  // Club 1: four people at $25 each and a meal credit for 4 people ($20); only Ann and Bo come.
  const lines = [
    ...[0, 1, 2, 3].map((index) => ({ key: `attendees.${index}.fee`, label: "Fee", amountCents: 2500, attendeeIndex: index })),
    { key: "meal_sponsorship_count", label: "Meal sponsorship credit", amountCents: -2000 },
  ];
  const r1 = await registration(ids.eventA, ids.club1, ["Ann", "Bo", "Cy", "Di"], { lines, responses: { meal_sponsorship_count: 4 }, definition, totalCents: 8000 });
  // Club 2: no price lines on file, two people and a $50 estimate; one comes.
  const r2 = await registration(ids.eventA, ids.club2, ["Ed", "Flo"]);
  await checkIn(ids.eventA, r1.attendees.Ann!);
  await checkIn(ids.eventA, r1.attendees.Bo!);
  await checkIn(ids.eventA, r2.attendees.Ed!);

  // Blocked until billing responsibility is recorded.
  const blocked = await prepareReconciliation({ eventId: ids.eventA, actorUserId: ids.staff }).catch((error: unknown) => error);
  assert(blocked instanceof AttendanceReconciliationError && blocked.code === "RESPONSIBILITY_NOT_READY" && blocked.blockers.length === 2, "preparing is blocked while responsibility is not recorded");
  assert((await prisma.attendanceReconciliationVersion.count({ where: { eventId: ids.eventA } })) === 0, "a blocked prepare writes nothing");
  await resolveEventBillingResponsibility(ids.eventA, { apply: true, actorUserId: ids.staff });

  // Prepare: attended people only, #409 credit applied to the people who attended.
  const first = await prepareReconciliation({ eventId: ids.eventA, actorUserId: ids.staff });
  assert(first.created && first.versionNumber === 1 && first.status === "DRAFT", "the first prepare makes a draft");
  const v1 = await prisma.attendanceReconciliationVersion.findUniqueOrThrow({ where: { id: first.versionId } });
  assert(v1.registeredCount === 6 && v1.checkedInCount === 3 && v1.noShowCount === 3 && v1.billableCount === 3, "counts: 6 registered, 3 checked in, 3 no-show, 3 billable");
  // Club 1: 2 x $25 less a credit for the 2 who came ($10) = $40. Club 2: prorated 1 of 2 of $50 = $25.
  assert(v1.estimatedCents === 13000 && v1.billableCents === 6500, "amounts: estimated $130, billable $65");
  assert(v1.status === "DRAFT" && v1.preparedByUserId === ids.staff && v1.ruleVersion === "attended-v1", "the draft records its preparer and rule version");

  // Idempotent re-run, and parallel prepares after a change leave one new version.
  const again = await prepareReconciliation({ eventId: ids.eventA, actorUserId: ids.staff2 });
  assert(!again.created && again.versionId === first.versionId, "an unchanged re-run returns the same version");
  assert((await prisma.attendanceReconciliationVersion.count({ where: { eventId: ids.eventA } })) === 1, "an unchanged re-run writes nothing");
  await checkIn(ids.eventA, r1.attendees.Cy!);
  const racing = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => prepareReconciliation({ eventId: ids.eventA, actorUserId: index % 2 ? ids.staff : ids.staff2 })));
  for (const outcome of racing) {
    if (outcome.status === "rejected") assert(outcome.reason instanceof AttendanceReconciliationError && outcome.reason.code === "CONCURRENT_CHANGE", "a losing prepare reports a concurrent change");
  }
  const afterRace = await prisma.attendanceReconciliationVersion.findMany({ where: { eventId: ids.eventA }, orderBy: { versionNumber: "asc" } });
  assert(afterRace.length === 2 && afterRace[0]!.status === "SUPERSEDED" && afterRace[1]!.status === "DRAFT" && afterRace[1]!.versionNumber === 2, "parallel prepares leave one new draft and supersede the old one");
  assert(afterRace[1]!.checkedInCount === 4 && afterRace[1]!.billableCents === 6500 + 2500 - 500, "the new draft sees Cy: +$25, credit for 3 people");

  // Approve (twice in parallel): once.
  const draftId = afterRace[1]!.id;
  const approvals = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => approveReconciliation({ eventId: ids.eventA, versionId: draftId, actorUserId: index % 2 ? ids.staff : ids.staff2 })));
  for (const outcome of approvals) assert(outcome.status === "fulfilled", "every parallel approval of one draft ends approved");
  const changedCount = approvals.filter((outcome) => outcome.status === "fulfilled" && outcome.value.changed).length;
  assert(changedCount === 1, "exactly one parallel approval does the approving");
  const approvedRow = await prisma.attendanceReconciliationVersion.findUniqueOrThrow({ where: { id: draftId } });
  assert(approvedRow.status === "APPROVED" && approvedRow.approvedAt !== null && (approvedRow.approvedByUserId === ids.staff || approvedRow.approvedByUserId === ids.staff2), "the approver is recorded");
  assert((await prisma.auditLog.count({ where: { eventId: ids.eventA, action: "ATTENDANCE_RECONCILIATION_APPROVED" } })) === 1, "one approval audit row");

  // The database refuses to rewrite an approved version.
  assert(await rejects(prisma.attendanceReconciliationVersion.update({ where: { id: draftId }, data: { billableCents: 1 } })), "an approved version's amount cannot be rewritten");
  assert(await rejects(prisma.attendanceReconciliationVersion.update({ where: { id: draftId }, data: { snapshot: {} } })), "an approved version's snapshot cannot be rewritten");
  assert(await rejects(prisma.attendanceReconciliationVersion.update({ where: { id: draftId }, data: { fingerprint: "other" } })), "an approved version's fingerprint cannot be rewritten");
  assert(await rejects(prisma.attendanceReconciliationVersion.update({ where: { id: draftId }, data: { status: "DRAFT", approvedAt: null } })), "an approved version cannot be reopened");
  assert(await rejects(prisma.attendanceReconciliationVersion.update({ where: { id: draftId }, data: { approvedAt: new Date(0) } })), "the approval time cannot be rewritten");
  assert(await rejects(prisma.attendanceReconciliationVersion.deleteMany({ where: { id: draftId } })), "an approved version cannot be deleted");
  assert(await rejects(prisma.attendanceReconciliationVersion.create({ data: { eventId: ids.eventA, versionNumber: 99, status: "APPROVED", approvedAt: new Date(), fingerprint: "x", ruleVersion: "x", invoiceGrouping: "PER_CHURCH", registeredCount: 0, checkedInCount: 0, noShowCount: 0, addedByStaffCount: 0, removedByStaffCount: 0, billableCount: 0, estimatedCents: 0, billableCents: 0, snapshot: {} } })), "a version cannot be created already approved");
  assert(await rejects(prisma.attendanceReconciliationVersion.create({ data: { eventId: ids.eventA, versionNumber: 98, fingerprint: "y", ruleVersion: "x", invoiceGrouping: "PER_CHURCH", registeredCount: 3, checkedInCount: 1, noShowCount: 5, addedByStaffCount: 0, removedByStaffCount: 0, billableCount: 1, estimatedCents: 0, billableCents: 0, snapshot: {} } })), "counts that do not reconcile are refused");

  // Attendance changes after approval: the approved version is untouched; the view flags it.
  const approvedBefore = JSON.stringify(await prisma.attendanceReconciliationVersion.findUniqueOrThrow({ where: { id: draftId } }));
  await recordAttendanceCorrection({ eventId: ids.eventA, attendeeId: r2.attendees.Flo!, kind: "MARK_ATTENDED", reason: REASON, actorUserId: ids.staff });
  await recordAttendanceCorrection({ eventId: ids.eventA, attendeeId: r1.attendees.Ann!, kind: "MARK_NOT_ATTENDED", reason: REASON, actorUserId: ids.staff2 });
  assert(JSON.stringify(await prisma.attendanceReconciliationVersion.findUniqueOrThrow({ where: { id: draftId } })) === approvedBefore, "attendance changes leave the approved version untouched");
  const viewAfter = await getAttendanceReconciliationView(ids.eventA);
  assert(viewAfter.isDeferred && viewAfter.approvedFreshness === "FACTS_CHANGED" && viewAfter.approved?.id === draftId, "the view flags that facts changed since approval");
  assert(viewAfter.isDeferred && viewAfter.liveTotals.addedByStaff === 1 && viewAfter.liveTotals.removedByStaff === 1 && viewAfter.liveTotals.billable === 4, "the live totals show the corrections apart from the check-ins");

  // A new draft; approving it supersedes the old approval; one approved version per event.
  const second = await prepareReconciliation({ eventId: ids.eventA, actorUserId: ids.staff });
  assert(second.created && second.versionNumber === 3, "a new draft is prepared");
  await approveReconciliation({ eventId: ids.eventA, versionId: second.versionId, actorUserId: ids.staff });
  const statuses = (await prisma.attendanceReconciliationVersion.findMany({ where: { eventId: ids.eventA }, orderBy: { versionNumber: "asc" } })).map((row) => row.status);
  assert(statuses.join() === "SUPERSEDED,SUPERSEDED,APPROVED", "approving a new draft supersedes the earlier approval");
  assert(await rejects(prisma.attendanceReconciliationVersion.update({ where: { id: draftId }, data: { status: "APPROVED", supersededAt: null } })), "a superseded version cannot be approved again");
  assert(await rejects(prisma.attendanceReconciliationVersion.update({ where: { id: draftId }, data: { billableCents: 7 } })), "a superseded version is still immutable");

  // A stale draft cannot be approved; another event's version is refused.
  await checkIn(ids.eventA, r1.attendees.Di!);
  const stale = await prepareReconciliation({ eventId: ids.eventA, actorUserId: ids.staff });
  await recordAttendanceCorrection({ eventId: ids.eventA, attendeeId: r1.attendees.Di!, kind: "MARK_NOT_ATTENDED", reason: REASON, actorUserId: ids.staff });
  const staleApprove = await approveReconciliation({ eventId: ids.eventA, versionId: stale.versionId, actorUserId: ids.staff }).catch((error: unknown) => error);
  assert(staleApprove instanceof AttendanceReconciliationError && staleApprove.code === "FACTS_CHANGED", "a draft whose facts changed cannot be approved");
  const crossVersion = await approveReconciliation({ eventId: ids.eventB, versionId: stale.versionId, actorUserId: ids.staff }).catch((error: unknown) => error);
  assert(crossVersion instanceof AttendanceReconciliationError && crossVersion.code === "VERSION_NOT_FOUND", "another event's version is refused");

  // Corrections: append-only with supersede; one active per person, even in parallel.
  const crossPerson = await recordAttendanceCorrection({ eventId: ids.eventB, attendeeId: r1.attendees.Bo!, kind: "MARK_NOT_ATTENDED", reason: "x", actorUserId: ids.staff }).catch((error: unknown) => error);
  assert(crossPerson instanceof AttendanceReconciliationError && crossPerson.code === "ATTENDEE_NOT_FOUND", "another event's person is refused");
  const noReason = await recordAttendanceCorrection({ eventId: ids.eventA, attendeeId: r1.attendees.Bo!, kind: "MARK_NOT_ATTENDED", reason: "  ", actorUserId: ids.staff }).catch((error: unknown) => error);
  assert(noReason instanceof AttendanceReconciliationError, "a correction needs a reason");
  const parallelCorrections = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
    recordAttendanceCorrection({ eventId: ids.eventA, attendeeId: r1.attendees.Bo!, kind: "MARK_NOT_ATTENDED", reason: `${REASON} ${index}`, actorUserId: index % 2 ? ids.staff : ids.staff2 })));
  assert(parallelCorrections.filter((outcome) => outcome.status === "fulfilled").length === 1, "parallel corrections of one person: exactly one lands");
  assert((await prisma.attendanceCorrection.count({ where: { registrationAttendeeId: r1.attendees.Bo!, supersededAt: null } })) === 1, "one active correction per person");
  await recordAttendanceCorrection({ eventId: ids.eventA, attendeeId: r1.attendees.Bo!, kind: "CLEAR", reason: REASON, actorUserId: ids.staff });
  const boHistory = await prisma.attendanceCorrection.findMany({ where: { registrationAttendeeId: r1.attendees.Bo! }, orderBy: { createdAt: "asc" } });
  assert(boHistory.length === 2 && boHistory[0]!.supersededAt !== null && boHistory[0]!.supersededByCorrectionId === boHistory[1]!.id && boHistory[1]!.kind === "CLEAR", "a later correction supersedes the earlier, which is kept");
  const active = boHistory[1]!;
  assert(await rejects(prisma.attendanceCorrection.create({ data: { eventId: ids.eventA, registrationId: r1.id, registrationAttendeeId: r1.attendees.Bo!, kind: "MARK_ATTENDED", reason: "second active", actorUserId: ids.staff } })), "the database allows one active correction per person");
  assert(await rejects(prisma.attendanceCorrection.create({ data: { eventId: ids.eventA, registrationId: r2.id, registrationAttendeeId: r2.attendees.Ed!, kind: "MARK_NOT_ATTENDED", reason: "   ", actorUserId: ids.staff } })), "the database refuses a blank reason");
  assert(await rejects(prisma.attendanceCorrection.update({ where: { id: active.id }, data: { reason: "rewritten" } })), "a correction's reason cannot be rewritten");
  assert(await rejects(prisma.attendanceCorrection.update({ where: { id: active.id }, data: { kind: "MARK_ATTENDED" } })), "a correction's kind cannot be rewritten");
  assert(await rejects(prisma.attendanceCorrection.update({ where: { id: boHistory[0]!.id }, data: { supersededAt: null, supersededByCorrectionId: null } })), "a superseded correction cannot be reopened");
  assert(await rejects(prisma.attendanceCorrection.deleteMany({ where: { id: active.id } })), "a correction cannot be deleted directly");

  // Foreign-key actions still work. A user is deleted: actor columns clear. A person is removed from
  // the roster: their corrections go. The event is deleted: versions and corrections go.
  await recordAttendanceCorrection({ eventId: ids.eventA, attendeeId: r2.attendees.Ed!, kind: "MARK_NOT_ATTENDED", reason: REASON, actorUserId: ids.doomed });
  const doomedVersion = await prepareReconciliation({ eventId: ids.eventA, actorUserId: ids.doomed });
  await prisma.user.delete({ where: { id: ids.doomed } });
  assert((await prisma.attendanceCorrection.count({ where: { registrationAttendeeId: r2.attendees.Ed!, actorUserId: null } })) === 1, "deleting a user clears the correction's actor");
  assert((await prisma.attendanceReconciliationVersion.findUniqueOrThrow({ where: { id: doomedVersion.versionId } })).preparedByUserId === null, "deleting a user clears the version's preparer");
  await prisma.registrationAttendee.delete({ where: { id: r2.attendees.Ed! } });
  assert((await prisma.attendanceCorrection.count({ where: { registrationAttendeeId: r2.attendees.Ed! } })) === 0, "removing a person from the roster removes their corrections");

  // Two drafts approved at the same instant: the database lets only one through.
  const draft = (versionNumber: number) => ({
    eventId: ids.eventB, versionNumber, fingerprint: `${P}-fp-${versionNumber}`, ruleVersion: "attended-v1", invoiceGrouping: "PER_CHURCH" as const,
    registeredCount: 1, checkedInCount: 1, noShowCount: 0, addedByStaffCount: 0, removedByStaffCount: 0, billableCount: 1, estimatedCents: 100, billableCents: 100, snapshot: {},
  });
  const dA = await prisma.attendanceReconciliationVersion.create({ data: draft(1) });
  const dB = await prisma.attendanceReconciliationVersion.create({ data: draft(2) });
  assert(await rejects(prisma.attendanceReconciliationVersion.create({ data: { ...draft(3), fingerprint: dA.fingerprint } })), "two live versions cannot share a fingerprint");
  const approveRaw = (id: string) => prisma.attendanceReconciliationVersion.updateMany({ where: { id, status: "DRAFT" }, data: { status: "APPROVED", approvedAt: new Date(), approvedByUserId: ids.staff } });
  const raced = await Promise.allSettled([approveRaw(dA.id), approveRaw(dB.id)]);
  assert(raced.filter((outcome) => outcome.status === "fulfilled").length === 1, "only one of two drafts can be approved at once");
  assert((await prisma.attendanceReconciliationVersion.count({ where: { eventId: ids.eventB, status: "APPROVED" } })) === 1, "one approved version for the event");

  // No audit row holds a reason or a name.
  const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { eventId: { in: [ids.eventA, ids.eventB] } } }));
  assert(audits.includes("ATTENDANCE_CORRECTED") && audits.includes("ATTENDANCE_RECONCILIATION_PREPARED"), "the actions are audited");
  assert(!audits.includes("Verify reason text") && !audits.includes("Ann Verify"), "no audit row holds a reason or a person's name");

  // Deleting the event removes its versions and corrections even though approved versions are protected.
  await prisma.event.delete({ where: { id: ids.eventA } });
  assert((await prisma.attendanceReconciliationVersion.count({ where: { eventId: ids.eventA } })) === 0 && (await prisma.attendanceCorrection.count({ where: { eventId: ids.eventA } })) === 0, "deleting an event removes its versions and corrections");

  console.log("Attendance reconciliation verified: attended-only billing, idempotent and race-safe prepares and approvals, immutable approved versions, append-only corrections, constraints and foreign-key actions hold.");
}

main()
  .then(async () => { await cleanup(); })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => { await prisma.$disconnect(); });
