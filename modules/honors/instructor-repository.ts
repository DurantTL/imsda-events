import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { currentCheckStateForPerson, namesAgree } from "@/modules/background-checks/repository";
import { refreshBackgroundCheckMatchesSafely } from "@/modules/background-checks/refresh-after-write";
import { neutralizePlaceholders } from "@/modules/club-applications/email";
import { getAccountEmailSender, isAccountEmailConfigured } from "@/modules/communications/account-email";
import { CLUB_INVITE_RESEND_COOLDOWN_MINUTES, clubInviteSignUpUrl } from "@/modules/club-imports/invites";
import { getServerEnv } from "@/lib/env";
import {
  EMAIL_BELONGS_TO_OTHER_MESSAGE,
  INSTRUCTOR_EDIT_GRACE_DAYS,
  ROSTER_CLOSED_MESSAGE,
  STERLING_REQUIRED_MESSAGE,
  applyBulkMark,
  applyPersonMark,
  instructorEditDeadline,
  instructorInviteEmail,
  instructorMarksOpen,
  instructorMarksStarted,
  instructorStatus,
  markChangeIsLocked,
  resendAvailableAt,
  sortInstructorRoster,
  sterlingAllowsRoster,
  toInstructorRosterRow,
  type BulkMarkAction,
  type InstructorRosterRow,
} from "@/modules/honors/instructor-domain";
import { offeringHonorsSelect, summarizeOfferingHonors } from "@/modules/honors/offering-honors";
import { WRITE_BACK_TRANSACTION, writeBackInstructorCompletions, type HonorsWeekendWriteBackResult } from "@/modules/honors/weekend-completion-repository";

/**
 * Honors Weekend class instructors (#833). Staff invite and assign; the
 * invited person accepts from their own attendee account; they then see only
 * the rosters of the classes they were assigned, with name and club only, and
 * mark attendance and completion. Every read and write here starts from the
 * signed-in account's own assignment: there is no class id a caller can supply
 * that widens it.
 */

export type HonorInstructorErrorCode =
  | "INVALID_INSTRUCTOR"
  | "CLASS_NOT_FOUND"
  | "INSTRUCTOR_NOT_FOUND"
  | "NOT_ASSIGNED"
  | "STERLING_REQUIRED"
  | "MARKS_CLOSED"
  | "MARKS_NOT_OPEN"
  | "ROSTER_CLOSED"
  | "INSTRUCTOR_EMAIL_CONFLICT"
  | "INVITE_RESEND_TOO_SOON"
  | "TRY_AGAIN"
  | "MARK_LOCKED"
  | "ENROLLMENT_NOT_FOUND"
  | "INVITE_NOT_FOUND"
  | "INVITE_NOT_OPEN"
  | "INVITE_EMAIL_MISMATCH";

const errorStatus: Record<HonorInstructorErrorCode, number> = {
  INVALID_INSTRUCTOR: 400,
  CLASS_NOT_FOUND: 404,
  INSTRUCTOR_NOT_FOUND: 404,
  NOT_ASSIGNED: 404,
  STERLING_REQUIRED: 403,
  MARKS_CLOSED: 409,
  MARKS_NOT_OPEN: 409,
  ROSTER_CLOSED: 404,
  INSTRUCTOR_EMAIL_CONFLICT: 409,
  INVITE_RESEND_TOO_SOON: 409,
  TRY_AGAIN: 409,
  MARK_LOCKED: 409,
  ENROLLMENT_NOT_FOUND: 404,
  INVITE_NOT_FOUND: 404,
  INVITE_NOT_OPEN: 409,
  INVITE_EMAIL_MISMATCH: 403,
};

export class HonorInstructorError extends Error {
  readonly status: number;
  constructor(public readonly code: HonorInstructorErrorCode, message: string) {
    super(message);
    this.name = "HonorInstructorError";
    this.status = errorStatus[code];
  }
}

const NOT_ASSIGNED_MESSAGE = "That class isn't one of yours.";
const ACTIVE_REGISTRATION = { status: { in: ["SUBMITTED" as const, "CONFIRMED" as const] } };

// ---------------------------------------------------------------- staff side

export type InstructorInviteSelection = { firstName: string; lastName: string; email: string; offeringIds: string[] };

async function assertOfferingsInEvent(tx: Prisma.TransactionClient, eventId: string, offeringIds: readonly string[]) {
  const unique = [...new Set(offeringIds)];
  if (unique.length === 0) throw new HonorInstructorError("INVALID_INSTRUCTOR", "Choose at least one class for this instructor.");
  const found = await tx.honorOffering.count({ where: { id: { in: unique }, eventId } });
  if (found !== unique.length) throw new HonorInstructorError("CLASS_NOT_FOUND", "One of those classes isn't part of this event.");
  return unique;
}

function eventInviteLinks(email: string) {
  // The sign-up link prefills the invited address, as a club invite's does.
  return { signUpUrl: clubInviteSignUpUrl(email), signInUrl: new URL("/account/sign-in", getServerEnv().APP_BASE_URL).toString() };
}

/**
 * Claims the right to send this instructor's invite email now: true for exactly one of any concurrent callers, and
 * only when none was sent within the club invite cooldown (#425). Stamps `sentAt` in the same statement.
 */
async function claimInviteSend(tx: Prisma.TransactionClient, instructorId: string, now: Date) {
  const cutoff = new Date(now.getTime() - CLUB_INVITE_RESEND_COOLDOWN_MINUTES * 60 * 1000);
  const claimed = await tx.honorInstructor.updateMany({
    where: { id: instructorId, OR: [{ sentAt: null }, { sentAt: { lte: cutoff } }] },
    data: { sentAt: now, sentCount: { increment: 1 } },
  });
  return claimed.count === 1;
}

async function queueInviteEmail(tx: Prisma.TransactionClient, instructor: { id: string; email: string; name: string; eventId: string }) {
  const [event, classes] = await Promise.all([
    tx.event.findUnique({ where: { id: instructor.eventId }, select: { name: true } }),
    tx.honorInstructorClass.findMany({
      where: { instructorId: instructor.id },
      select: { offering: { select: { honors: offeringHonorsSelect } } },
    }),
  ]);
  const sender = getAccountEmailSender();
  // Names are typed by staff and the body is scanned for `{{...}}` sentinels at delivery: break braces up.
  const content = instructorInviteEmail({
    name: neutralizePlaceholders(instructor.name),
    email: instructor.email,
    eventName: neutralizePlaceholders(event?.name ?? "the event"),
    classNames: classes.map((row) => neutralizePlaceholders(summarizeOfferingHonors(row.offering.honors).honorName)),
    ...eventInviteLinks(instructor.email),
  });
  const message = await tx.messageOutbox.create({
    data: {
      eventId: null,
      templateKey: "CLUB_INVITE",
      recipientKind: "ACCOUNT",
      recipientEmail: instructor.email,
      recipientName: instructor.name || null,
      senderNameSnapshot: sender.name,
      senderEmailSnapshot: sender.address,
      replyToEmailSnapshot: sender.replyTo,
      subjectSnapshot: content.subject,
      bodyTextSnapshot: content.bodyText,
      metadata: { trigger: "HONOR_INSTRUCTOR_INVITED", accountEmail: true, realDelivery: true, honorInstructorId: instructor.id },
      idempotencyKey: `honor-instructor-invite:${instructor.id}:${randomUUID()}`,
      correlationId: randomUUID(),
      status: "PENDING",
    },
    select: { id: true },
  });
  return message.id;
}

/**
 * Staff invite an instructor to chosen classes of one event, or add classes to
 * (and re-invite) one already invited. A person is found by email or created
 * (the Sterling Volunteers check is matched to them). The email is queued
 * right away when account email is set up; otherwise the invite waits and
 * staff resend it later.
 */
export async function inviteHonorInstructor(eventId: string, input: InstructorInviteSelection, actorUserId: string, now = new Date()) {
  const email = input.email.trim().toLowerCase();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!email || !firstName || !lastName) throw new HonorInstructorError("INVALID_INSTRUCTOR", "Enter the instructor's first name, last name and email.");
  const canSend = isAccountEmailConfigured();
  const result = await getPrisma().$transaction(async (tx) => {
    const offeringIds = await assertOfferingsInEvent(tx, eventId, input.offeringIds);
    // The person is found by email, but only if the typed name agrees: someone sharing an address (a spouse, say)
    // must not pass on the other's Sterling Volunteers check.
    const found = await tx.person.findUnique({ where: { normalizedEmail: email }, select: { id: true, firstName: true, lastName: true } });
    if (found && !namesAgree(`${firstName} ${lastName}`, found)) {
      throw new HonorInstructorError("INSTRUCTOR_EMAIL_CONFLICT", EMAIL_BELONGS_TO_OTHER_MESSAGE);
    }
    const person = found ?? await tx.person.create({
      data: { firstName, lastName, normalizedEmail: email },
      select: { id: true, firstName: true, lastName: true },
    });
    const name = `${person.firstName} ${person.lastName}`.trim();
    const existing = await tx.honorInstructor.findUnique({ where: { eventId_email: { eventId, email } }, select: { id: true, personId: true, revokedAt: true } });
    // An existing row for this email belongs to the person it was made for; never re-point it.
    if (existing && existing.personId !== person.id) throw new HonorInstructorError("INSTRUCTOR_EMAIL_CONFLICT", EMAIL_BELONGS_TO_OTHER_MESSAGE);
    const instructor = existing
      ? await tx.honorInstructor.update({
        where: { id: existing.id },
        // A removed instructor invited again starts over: exactly the new classes, and they must accept again.
        data: { revokedAt: null, revokedByUserId: null, name, ...(existing.revokedAt ? { acceptedAt: null, attendeeAccountId: null, sentAt: null } : {}) },
        select: { id: true, email: true, name: true, eventId: true },
      })
      : await tx.honorInstructor.create({
        data: { eventId, personId: person.id, email, name, createdByUserId: actorUserId },
        select: { id: true, email: true, name: true, eventId: true },
      });
    if (existing?.revokedAt) await tx.honorInstructorClass.deleteMany({ where: { instructorId: instructor.id } });
    await tx.honorInstructorClass.createMany({ data: offeringIds.map((offeringId) => ({ instructorId: instructor.id, offeringId })), skipDuplicates: true });
    // The same cooldown as Resend: an open invite emailed a moment ago is not emailed again.
    const messageId = canSend && await claimInviteSend(tx, instructor.id, now) ? await queueInviteEmail(tx, instructor) : null;
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "HONOR_INSTRUCTOR_INVITED",
      entityType: "HonorInstructor",
      entityId: instructor.id,
      summary: "Invited an instructor to teach Honors Weekend classes.",
      metadata: { eventId, offeringIds, emailQueued: Boolean(messageId), reinvite: Boolean(existing) },
    }, tx);
    return { instructorId: instructor.id, personId: person.id, emailQueued: Boolean(messageId) };
  });
  await refreshBackgroundCheckMatchesSafely([result.personId]);
  return { instructorId: result.instructorId, emailQueued: result.emailQueued };
}

/** Replaces the classes an instructor teaches. Marks already made stay; the instructor just stops seeing a removed class. */
export async function setHonorInstructorClasses(eventId: string, instructorId: string, offeringIds: string[], actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const instructor = await tx.honorInstructor.findFirst({ where: { id: instructorId, eventId }, select: { id: true } });
    if (!instructor) throw new HonorInstructorError("INSTRUCTOR_NOT_FOUND", "That instructor could not be found.");
    const keep = await assertOfferingsInEvent(tx, eventId, offeringIds);
    await tx.honorInstructorClass.deleteMany({ where: { instructorId, offeringId: { notIn: keep } } });
    await tx.honorInstructorClass.createMany({ data: keep.map((offeringId) => ({ instructorId, offeringId })), skipDuplicates: true });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "HONOR_INSTRUCTOR_CLASSES_CHANGED",
      entityType: "HonorInstructor",
      entityId: instructorId,
      summary: "Changed the classes an Honors Weekend instructor teaches.",
      metadata: { eventId, offeringIds: keep },
    }, tx);
  });
}

export async function resendHonorInstructorInvite(eventId: string, instructorId: string, actorUserId: string, now = new Date()) {
  if (!isAccountEmailConfigured()) {
    throw new HonorInstructorError("INVALID_INSTRUCTOR", "Account email isn't set up on this server, so invites can't be sent yet.");
  }
  await getPrisma().$transaction(async (tx) => {
    const instructor = await tx.honorInstructor.findFirst({
      where: { id: instructorId, eventId, revokedAt: null, acceptedAt: null },
      select: { id: true, email: true, name: true, eventId: true, sentAt: true },
    });
    if (!instructor) throw new HonorInstructorError("INSTRUCTOR_NOT_FOUND", "There's no open invite to resend for that instructor.");
    const next = resendAvailableAt(instructor.sentAt, CLUB_INVITE_RESEND_COOLDOWN_MINUTES);
    // Claimed in one conditional update, so two concurrent resends can't both send.
    if ((next && next > now) || !(await claimInviteSend(tx, instructor.id, now))) {
      throw new HonorInstructorError("INVITE_RESEND_TOO_SOON", `That invite was sent a moment ago. Try again in ${CLUB_INVITE_RESEND_COOLDOWN_MINUTES} minutes.`);
    }
    await queueInviteEmail(tx, instructor);
    await writeAuditLog({
      eventId, actorUserId, action: "HONOR_INSTRUCTOR_INVITE_RESENT", entityType: "HonorInstructor", entityId: instructor.id,
      summary: "Resent an Honors Weekend instructor invite.", metadata: { eventId },
    }, tx);
  });
}

/** Takes an instructor's access away. Their past marks and the honors already recorded stay. */
export async function removeHonorInstructor(eventId: string, instructorId: string, actorUserId: string, now = new Date()) {
  await getPrisma().$transaction(async (tx) => {
    const updated = await tx.honorInstructor.updateMany({
      where: { id: instructorId, eventId, revokedAt: null },
      data: { revokedAt: now, revokedByUserId: actorUserId },
    });
    if (updated.count === 0) throw new HonorInstructorError("INSTRUCTOR_NOT_FOUND", "That instructor could not be found.");
    // Their classes go with their access, so a later invite can't bring old ones back.
    await tx.honorInstructorClass.deleteMany({ where: { instructorId } });
    await writeAuditLog({
      eventId, actorUserId, action: "HONOR_INSTRUCTOR_REMOVED", entityType: "HonorInstructor", entityId: instructorId,
      summary: "Removed an Honors Weekend instructor.", metadata: { eventId },
    }, tx);
  });
}

export type StaffInstructorRow = {
  id: string;
  name: string;
  email: string;
  status: ReturnType<typeof instructorStatus>;
  sentAt: string | null;
  sterlingCurrent: boolean;
  /** CURRENT, FLAGGED ("!" counts as not current here), EXPIRED, MISSING or NOT_COMPLIANT. */
  sterlingState: string;
  offeringIds: string[];
};

export async function listHonorInstructors(eventId: string): Promise<{ instructors: StaffInstructorRow[]; classes: Array<{ id: string; label: string }> }> {
  const prisma = getPrisma();
  const [rows, offerings] = await Promise.all([
    prisma.honorInstructor.findMany({
      where: { eventId, revokedAt: null },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, email: true, personId: true, sentAt: true, acceptedAt: true, revokedAt: true, classes: { select: { offeringId: true } } },
    }),
    prisma.honorOffering.findMany({
      where: { eventId },
      orderBy: [{ session: { sortOrder: "asc" } }, { createdAt: "asc" }],
      select: { id: true, span: true, session: { select: { name: true } }, site: { select: { name: true } }, teacherName: true, honors: offeringHonorsSelect },
    }),
  ]);
  const instructors = await Promise.all(rows.map(async (row) => {
    const sterlingState = await currentCheckStateForPerson(row.personId);
    return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: instructorStatus(row),
    sentAt: row.sentAt?.toISOString() ?? null,
    sterlingCurrent: sterlingAllowsRoster(sterlingState),
    sterlingState,
    offeringIds: row.classes.map((entry) => entry.offeringId),
  };
  }));
  return {
    instructors,
    classes: offerings.map((offering) => ({
      id: offering.id,
      label: [summarizeOfferingHonors(offering.honors).honorName, offering.span === "ALL_SESSIONS" ? "All sessions" : offering.session?.name, offering.site?.name]
        .filter(Boolean).join(" · "),
    })),
  };
}

// ------------------------------------------------------------- account side

export type InstructorInviteForAccount = { id: string; eventName: string; classNames: string[] };

/** Invites waiting on this verified email, for the account page (accepted only by the person themselves). */
export async function listInstructorInvitesForAccount(verifiedEmail: string, now = new Date()): Promise<InstructorInviteForAccount[]> {
  const rows = await getPrisma().honorInstructor.findMany({
    where: { email: verifiedEmail.trim().toLowerCase(), acceptedAt: null, revokedAt: null, classes: { some: {} } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      event: { select: { name: true, endsAt: true } },
      classes: { select: { offering: { select: { honors: offeringHonorsSelect } } } },
    },
  });
  return rows
    .filter((row) => instructorMarksOpen(row.event.endsAt, now))
    .map((row) => ({
      id: row.id,
      eventName: row.event.name,
      classNames: row.classes.map((entry) => summarizeOfferingHonors(entry.offering.honors).honorName),
    }));
}

/**
 * The invited person accepts, from their own signed-in account. The account's
 * verified email must be the invite's address; nothing else links an account
 * to an instructor row.
 */
export async function acceptInstructorInvite(instructorId: string, account: { id: string; verifiedEmail: string }, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const invite = await tx.honorInstructor.findUnique({
      where: { id: instructorId },
      select: { id: true, eventId: true, email: true, acceptedAt: true, revokedAt: true, attendeeAccountId: true, event: { select: { endsAt: true } } },
    });
    if (!invite) throw new HonorInstructorError("INVITE_NOT_FOUND", "That invite could not be found.");
    if (invite.email !== account.verifiedEmail.trim().toLowerCase()) {
      throw new HonorInstructorError("INVITE_EMAIL_MISMATCH", "This invite was sent to a different email address. Sign in with the account that uses that address.");
    }
    if (invite.revokedAt || invite.acceptedAt || !instructorMarksOpen(invite.event.endsAt, now)) {
      throw new HonorInstructorError("INVITE_NOT_OPEN", "That invite was already accepted or is no longer open.");
    }
    await tx.honorInstructor.update({ where: { id: invite.id }, data: { attendeeAccountId: account.id, acceptedAt: now } });
    await writeAuditLog({
      eventId: invite.eventId,
      action: "HONOR_INSTRUCTOR_ACCEPTED",
      entityType: "HonorInstructor",
      entityId: invite.id,
      summary: "An Honors Weekend instructor accepted their invite.",
      metadata: { eventId: invite.eventId, actorAttendeeAccountId: account.id },
    }, tx);
    return { instructorId: invite.id };
  });
}

/** Whether this account teaches any class: a cheap check for the account home page. */
export async function accountIsInstructor(accountId: string) {
  return (await getPrisma().honorInstructor.count({ where: { attendeeAccountId: accountId, acceptedAt: { not: null }, revokedAt: null, classes: { some: {} } } })) > 0;
}

export type InstructorClassSummary = {
  offeringId: string;
  honorName: string;
  session: string;
  room: string;
  eventName: string;
  editable: boolean;
};

/** The classes this account teaches: class names only, no person data. */
export async function listInstructorClasses(accountId: string, now = new Date()): Promise<{ classes: InstructorClassSummary[]; sterlingCurrent: boolean | null }> {
  const rows = await getPrisma().honorInstructorClass.findMany({
    where: { instructor: { attendeeAccountId: accountId, acceptedAt: { not: null }, revokedAt: null } },
    orderBy: [{ offering: { event: { startsAt: "asc" } } }, { offering: { session: { sortOrder: "asc" } } }],
    select: {
      instructor: { select: { personId: true } },
      offering: {
        select: {
          id: true, span: true, location: true,
          session: { select: { name: true } },
          honors: offeringHonorsSelect,
          event: { select: { name: true, endsAt: true } },
        },
      },
    },
  });
  const personIds = [...new Set(rows.map((row) => row.instructor.personId))];
  const states = await Promise.all(personIds.map(async (personId) => sterlingAllowsRoster(await currentCheckStateForPerson(personId, now))));
  return {
    classes: rows.map((row) => ({
      offeringId: row.offering.id,
      honorName: summarizeOfferingHonors(row.offering.honors).honorName,
      session: row.offering.span === "ALL_SESSIONS" ? "All sessions" : row.offering.session?.name ?? "Session",
      room: row.offering.location,
      eventName: row.offering.event.name,
      editable: instructorMarksOpen(row.offering.event.endsAt, now),
    })),
    sterlingCurrent: personIds.length === 0 ? null : states.every(Boolean),
  };
}

async function loadAssignment(accountId: string, offeringId: string) {
  const row = await getPrisma().honorInstructorClass.findFirst({
    where: { offeringId, instructor: { attendeeAccountId: accountId, acceptedAt: { not: null }, revokedAt: null } },
    select: {
      instructor: { select: { id: true, personId: true, eventId: true } },
      offering: {
        select: {
          id: true, eventId: true, span: true, location: true,
          session: { select: { name: true } },
          honors: offeringHonorsSelect,
          event: { select: { id: true, name: true, startsAt: true, endsAt: true } },
        },
      },
    },
  });
  // An assignment only counts for the event its instructor row belongs to.
  if (!row || row.instructor.eventId !== row.offering.eventId) throw new HonorInstructorError("NOT_ASSIGNED", NOT_ASSIGNED_MESSAGE);
  return row;
}

type Assignment = Awaited<ReturnType<typeof loadAssignment>>;

function classHeader(assignment: Assignment, now: Date) {
  const { offering } = assignment;
  return {
    offeringId: offering.id,
    honorName: summarizeOfferingHonors(offering.honors).honorName,
    session: offering.span === "ALL_SESSIONS" ? "All sessions" : offering.session?.name ?? "Session",
    room: offering.location,
    eventName: offering.event.name,
    editable: instructorMarksStarted(offering.event.startsAt, now) && instructorMarksOpen(offering.event.endsAt, now),
    notOpenYet: !instructorMarksStarted(offering.event.startsAt, now),
    editDeadline: instructorEditDeadline(offering.event.endsAt).toISOString(),
    editGraceDays: INSTRUCTOR_EDIT_GRACE_DAYS,
  };
}

export type InstructorRosterView =
  | { status: "OK"; header: ReturnType<typeof classHeader>; rows: InstructorRosterRow[] }
  | { status: "STERLING_REQUIRED"; header: ReturnType<typeof classHeader>; message: string };

const rosterEnrollmentSelect = {
  id: true,
  organization: { select: { name: true } },
  registrationAttendee: { select: { person: { select: { firstName: true, lastName: true } } } },
  instructorMark: { select: { attended: true, completed: true } },
  weekendCompletions: { select: { memberHonorEntry: { select: { void: { select: { id: true } } } } } },
} satisfies Prisma.HonorEnrollmentSelect;

function rosterRows(enrollments: Array<Prisma.HonorEnrollmentGetPayload<{ select: typeof rosterEnrollmentSelect }>>) {
  return sortInstructorRoster(enrollments.map((enrollment) => toInstructorRosterRow({
    enrollmentId: enrollment.id,
    firstName: enrollment.registrationAttendee.person.firstName,
    lastName: enrollment.registrationAttendee.person.lastName,
    clubName: enrollment.organization?.name ?? null,
    mark: enrollment.instructorMark,
    links: enrollment.weekendCompletions.map((link) => ({ voided: Boolean(link.memberHonorEntry.void) })),
  })));
}

async function requireSterling(assignment: Assignment, now: Date) {
  if (!sterlingAllowsRoster(await currentCheckStateForPerson(assignment.instructor.personId, now))) {
    throw new HonorInstructorError("STERLING_REQUIRED", STERLING_REQUIRED_MESSAGE);
  }
}

/** One class roster for the signed-in instructor: name and club only, or the Sterling Volunteers message. */
export async function getInstructorRoster(accountId: string, offeringId: string, now = new Date()): Promise<InstructorRosterView> {
  const assignment = await loadAssignment(accountId, offeringId);
  // Reads close at the same deadline as marks.
  if (!instructorMarksOpen(assignment.offering.event.endsAt, now)) throw new HonorInstructorError("ROSTER_CLOSED", ROSTER_CLOSED_MESSAGE);
  const header = classHeader(assignment, now);
  try {
    await requireSterling(assignment, now);
  } catch (error) {
    if (error instanceof HonorInstructorError && error.code === "STERLING_REQUIRED") return { status: "STERLING_REQUIRED", header, message: error.message };
    throw error;
  }
  const enrollments = await getPrisma().honorEnrollment.findMany({
    where: { offeringId, registration: ACTIVE_REGISTRATION },
    select: rosterEnrollmentSelect,
  });
  return { status: "OK", header, rows: rosterRows(enrollments) };
}

export type InstructorMarkInput =
  | { action: BulkMarkAction }
  | { action: "SET"; enrollmentId: string; attended?: boolean; completed?: boolean };

export type InstructorMarkResult = {
  view: Extract<InstructorRosterView, { status: "OK" }>;
  changed: number;
  /** People skipped because their completion is already in the honor record (staff void it instead). */
  locked: number;
  writeBack: HonorsWeekendWriteBackResult | null;
};

/**
 * One-click or per-person marks on one of the instructor's own classes.
 * Order of checks: the class is theirs, their Sterling Volunteers check is
 * current, the 14-day window is open. The marks, then Completed's honor-record
 * write (the existing write-back, in its own transaction after the marks
 * commit; a person it couldn't write stays marked and staff can run the
 * write-back), then the audit row, hold counts and ids only.
 */
export async function markInstructorClass(accountId: string, offeringId: string, input: InstructorMarkInput, now = new Date()): Promise<InstructorMarkResult> {
  const assignment = await loadAssignment(accountId, offeringId);
  await requireSterling(assignment, now);
  if (!instructorMarksStarted(assignment.offering.event.startsAt, now)) {
    throw new HonorInstructorError("MARKS_NOT_OPEN", "Marks open when the event starts. You can already see your roster.");
  }
  if (!instructorMarksOpen(assignment.offering.event.endsAt, now)) {
    throw new HonorInstructorError("MARKS_CLOSED", `Marks closed ${INSTRUCTOR_EDIT_GRACE_DAYS} days after the event ended. Ask the conference office if something needs to change.`);
  }
  const prisma = getPrisma();
  const instructorId = assignment.instructor.id;
  const outcome = await prisma.$transaction(async (tx) => {
    // The write-back's own per-event lock, so "recorded" is read under the lock the write-back writes under. It also
    // serializes marks calls on a class. A staff write-back can hold it for a while: hence the write-back's timeouts.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`honors-weekend-write-back:${assignment.offering.eventId}`}))`;
    // Access can change while waiting for the lock: check the assignment again under it.
    const stillAssigned = await tx.honorInstructorClass.count({
      where: { offeringId, instructorId, instructor: { attendeeAccountId: accountId, acceptedAt: { not: null }, revokedAt: null } },
    });
    if (stillAssigned === 0) throw new HonorInstructorError("NOT_ASSIGNED", NOT_ASSIGNED_MESSAGE);
    const enrollments = await tx.honorEnrollment.findMany({ where: { offeringId, registration: ACTIVE_REGISTRATION }, select: rosterEnrollmentSelect });
    const rows = rosterRows(enrollments);
    const targets = input.action === "SET" ? rows.filter((row) => row.enrollmentId === input.enrollmentId) : rows;
    if (input.action === "SET" && targets.length === 0) throw new HonorInstructorError("ENROLLMENT_NOT_FOUND", "That person isn't in this class.");
    let changed = 0;
    let locked = 0;
    for (const row of targets) {
      const current = { attended: row.attended, completed: row.completed };
      const next = input.action === "SET"
        ? applyPersonMark(current, { ...(input.attended === undefined ? {} : { attended: input.attended }), ...(input.completed === undefined ? {} : { completed: input.completed }) })
        : applyBulkMark(input.action, current);
      if (markChangeIsLocked(row, next)) {
        if (input.action === "SET") throw new HonorInstructorError("MARK_LOCKED", "This completion is already in the member's honor record. Ask the conference office to void it if it was a mistake.");
        locked += 1;
        continue;
      }
      const hasMark = row.attended || row.completed;
      if (next === null) {
        const removed = await tx.honorEnrollmentMark.deleteMany({ where: { enrollmentId: row.enrollmentId } });
        if (removed.count > 0 && hasMark) changed += 1;
        continue;
      }
      if (next.attended === row.attended && next.completed === row.completed && hasMark) continue;
      await tx.honorEnrollmentMark.upsert({
        where: { enrollmentId: row.enrollmentId },
        create: { enrollmentId: row.enrollmentId, attended: next.attended, completed: next.completed, markedByInstructorId: instructorId },
        update: { attended: next.attended, completed: next.completed, markedByInstructorId: instructorId },
      });
      changed += 1;
    }
    await writeAuditLog({
      eventId: assignment.offering.eventId,
      action: "HONOR_CLASS_MARKS_UPDATED",
      entityType: "HonorOffering",
      entityId: offeringId,
      summary: input.action === "SET" ? "An instructor changed one person's class marks." : "An instructor used a one-click class mark.",
      metadata: {
        eventId: assignment.offering.eventId,
        offeringId,
        instructorId,
        actorAttendeeAccountId: accountId,
        action: input.action,
        changed,
        locked,
        ...(input.action === "SET" ? { enrollmentId: input.enrollmentId } : {}),
      },
    }, tx);
    return { changed, locked };
  }, WRITE_BACK_TRANSACTION).catch((error: unknown) => {
    // Waiting on a long write-back can outlast the transaction's own limits: a clean "try again", not a 500.
    if (typeof error === "object" && error !== null && "code" in error && ((error as { code: unknown }).code === "P2028" || (error as { code: unknown }).code === "P2034")) {
      throw new HonorInstructorError("TRY_AGAIN", "The honor records are being updated right now. Try again in a moment.");
    }
    throw error;
  });

  // Completed feeds the honor record: everyone in this class who is marked completed and not yet written.
  const afterMarks = await prisma.honorEnrollment.findMany({ where: { offeringId, registration: ACTIVE_REGISTRATION }, select: rosterEnrollmentSelect });
  const pending = rosterRows(afterMarks).filter((row) => row.completed && !row.recorded).map((row) => row.enrollmentId);
  const writeBack = pending.length > 0 ? await writeBackInstructorCompletions(assignment.offering.eventId, pending, accountId) : null;
  const finalEnrollments = writeBack
    ? await prisma.honorEnrollment.findMany({ where: { offeringId, registration: ACTIVE_REGISTRATION }, select: rosterEnrollmentSelect })
    : afterMarks;
  return {
    view: { status: "OK", header: classHeader(assignment, now), rows: rosterRows(finalEnrollments) },
    changed: outcome.changed,
    locked: outcome.locked,
    writeBack,
  };
}
