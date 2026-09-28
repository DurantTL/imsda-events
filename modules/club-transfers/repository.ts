import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { isAccountEmailConfigured, getAccountEmailSender } from "@/modules/communications/account-email";
import { clubYearFor } from "@/modules/club-rosters/domain";
import type { TransferActor } from "@/modules/club-transfers/access";
import { transferActorAttribution } from "@/modules/club-transfers/access";
import {
  acknowledgeDueAt as computeAcknowledgeDueAt,
  isOverdueForStaffQueue,
  transferOrganizationsProblem,
  transferReasonProblem,
  type MemberTransferResolution,
} from "@/modules/club-transfers/domain";
import { directorGrantIsActive } from "@/modules/organizations/director-grants-domain";
import type { InitiateTransferInput } from "@/modules/club-transfers/schemas";

/**
 * Club member transfer storage (#489). One append-only `MemberTransferEvent`
 * row per thing that happens is written for every state change, which is
 * both the audit trail and what "show the transfer in both clubs' history"
 * reads from (`listClubTransfers`).
 *
 * No medical or insurance data is read or moved anywhere in this module —
 * this module never selects `BackgroundCheck` or any insurance field, only
 * the roster columns, the sealed birth date, and the honor record (which
 * needs no code change at all: it already keys off `personId` alone, #486).
 */

export type MemberTransferErrorCode =
  | "MEMBER_NOT_FOUND"
  | "TRANSFER_NOT_FOUND"
  | "SAME_CLUB"
  | "REASON_REQUIRED"
  | "ALREADY_ON_ROSTER"
  | "ALREADY_RESOLVED";

export class MemberTransferError extends Error {
  constructor(public readonly code: MemberTransferErrorCode, message: string) {
    super(message);
    this.name = "MemberTransferError";
  }
}

const rosterMemberSelect = {
  id: true,
  organizationId: true,
  clubYear: true,
  personId: true,
  attendeeType: true,
  role: true,
  classLevel: true,
  reportedAge: true,
  gender: true,
  sealedBirthDate: true,
  willingToDrive: true,
  status: true,
} satisfies Prisma.ClubRosterMemberSelect;

/**
 * Active roster members at other clubs matching a name, for a receiving
 * director enrolling someone to search by (#489). Never a birth date or
 * age — a cross-club search is never the right place for that (ADR 0005
 * Addendum A is about one's own club's roster, not every club's).
 */
export async function searchTransferCandidates(query: string, excludingOrganizationId: string, now = new Date()) {
  const clubYear = clubYearFor(now);
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (needle.length < 2) return [];
  const members = await getPrisma().clubRosterMember.findMany({
    where: {
      clubYear,
      status: "ACTIVE",
      organizationId: { not: excludingOrganizationId },
      person: { isNot: null },
    },
    select: {
      id: true,
      organizationId: true,
      attendeeType: true,
      person: { select: { firstName: true, lastName: true } },
      organization: { select: { name: true } },
    },
    take: 500,
  });
  return members
    .filter((member) => `${member.person!.firstName} ${member.person!.lastName}`.toLocaleLowerCase("en-US").includes(needle))
    .map((member) => ({
      rosterMemberId: member.id,
      organizationId: member.organizationId,
      organizationName: member.organization.name,
      firstName: member.person!.firstName,
      lastName: member.person!.lastName,
      attendeeType: member.attendeeType,
    }))
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName))
    .slice(0, 25);
}

function audit(
  tx: Prisma.TransactionClient,
  actor: TransferActor,
  action: string,
  entityId: string,
  summary: string,
  metadata: Record<string, Prisma.InputJsonValue> = {},
) {
  const attribution = transferActorAttribution(actor);
  return writeAuditLog({
    ...("userId" in attribution ? { actorUserId: attribution.userId } : {}),
    action,
    entityType: "MemberTransfer",
    entityId,
    summary,
    metadata: {
      ...("accountId" in attribution ? { actorAttendeeAccountId: attribution.accountId } : {}),
      ...("actAsId" in attribution && attribution.actAsId ? { actAsId: attribution.actAsId } : {}),
      ...metadata,
    },
  }, tx);
}

function transferEvent(
  tx: Prisma.TransactionClient,
  transferId: string,
  type: "INITIATED" | "ACKNOWLEDGED" | "STAFF_FINISHED" | "STAFF_OVERRIDDEN" | "REGISTRATION_REPOINTED" | "NOTIFIED",
  actor: TransferActor | null,
  note: string,
  metadata: Prisma.InputJsonValue = {},
) {
  const attribution = actor ? transferActorAttribution(actor) : null;
  return tx.memberTransferEvent.create({
    data: {
      transferId,
      type,
      note,
      metadata,
      ...(attribution && "accountId" in attribution ? { actorAccountId: attribution.accountId } : {}),
      ...(attribution && "userId" in attribution ? { actorUserId: attribution.userId } : {}),
    },
  });
}

/** Active directors and deputies of a club, for notifications (never a bulk send: one club's leaders at a time). */
async function activeClubLeaders(tx: Prisma.TransactionClient, organizationId: string, now: Date) {
  const grants = await tx.clubDirectorGrant.findMany({
    where: { organizationId, role: { in: ["DIRECTOR", "DEPUTY"] }, revokedAt: null },
    select: { role: true, effectiveFrom: true, effectiveTo: true, revokedAt: true, attendeeAccount: { select: { id: true, email: true, displayName: true } } },
  });
  return grants
    .filter((grant) => directorGrantIsActive(grant, now))
    .map((grant) => grant.attendeeAccount);
}

function transferNotificationEmail(input: {
  templateKey: "MEMBER_TRANSFER_STARTED" | "MEMBER_TRANSFER_COMPLETED";
  memberName: string;
  fromClubName: string;
  toClubName: string;
  reason: string;
}) {
  if (input.templateKey === "MEMBER_TRANSFER_STARTED") {
    return {
      subject: `${input.memberName} is transferring to ${input.toClubName}`,
      bodyText: [
        `${input.toClubName} has started a transfer for ${input.memberName} on IMSDA Events.`,
        "",
        `Reason given: ${input.reason}`,
        "",
        `Sign in to acknowledge it from ${input.fromClubName}'s roster. If you don't acknowledge it within 14 days, conference staff will follow up.`,
        "",
        "IMSDA Events",
      ].join("\n"),
    };
  }
  return {
    subject: `${input.memberName} has transferred to ${input.toClubName}`,
    bodyText: [
      `${input.memberName} has moved from ${input.fromClubName} to ${input.toClubName} on IMSDA Events.`,
      "",
      `Reason given: ${input.reason}`,
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

async function queueTransferNotification(
  tx: Prisma.TransactionClient,
  transferId: string,
  templateKey: "MEMBER_TRANSFER_STARTED" | "MEMBER_TRANSFER_COMPLETED",
  recipients: Array<{ accountId?: string; email: string; name?: string | null }>,
  content: { subject: string; bodyText: string },
) {
  // Best-effort, same as the club team role notice: the transfer stands even
  // where account email isn't configured (local dev). Never a bulk send —
  // one message per person party to this one transfer.
  if (!isAccountEmailConfigured() || recipients.length === 0) return;
  const sender = getAccountEmailSender();
  for (const recipient of recipients) {
    if (!recipient.email) continue;
    await tx.messageOutbox.create({
      data: {
        eventId: null,
        templateKey,
        recipientKind: "ACCOUNT",
        recipientEmail: recipient.email,
        recipientName: recipient.name ?? null,
        accountAttendeeId: recipient.accountId ?? null,
        senderNameSnapshot: sender.name,
        senderEmailSnapshot: sender.address,
        replyToEmailSnapshot: sender.replyTo,
        subjectSnapshot: content.subject,
        bodyTextSnapshot: content.bodyText,
        metadata: { trigger: templateKey, transferId, accountEmail: true, realDelivery: true },
        idempotencyKey: `member-transfer:${transferId}:${templateKey}:${recipient.email}:${recipient.accountId ?? "guest"}`,
        correlationId: transferId,
        status: "PENDING",
      },
    });
  }
  await transferEvent(tx, transferId, "NOTIFIED", null, `${templateKey} queued to ${recipients.length} recipient(s).`, { templateKey });
}

/**
 * The receiving club's director starts a transfer while enrolling the
 * member (#489): the sending club's roster row (`fromRosterMemberId`) is
 * left active — a new roster row is created at the receiving club right
 * away, copying the roster fields and sealed birth date, but the move isn't
 * final until the sending club acknowledges it or conference staff finish
 * or override it. There is no one-sided silent move.
 */
export async function initiateTransfer(
  toOrganizationId: string,
  input: InitiateTransferInput,
  actor: TransferActor,
  now = new Date(),
) {
  const reasonProblem = transferReasonProblem(input.reason);
  if (reasonProblem) throw new MemberTransferError("REASON_REQUIRED", reasonProblem);
  const orgProblem = transferOrganizationsProblem(input.fromOrganizationId, toOrganizationId);
  if (orgProblem) throw new MemberTransferError("SAME_CLUB", orgProblem);

  return getPrisma().$transaction(async (tx) => {
    const fromMemberRow = await tx.clubRosterMember.findFirst({
      where: { id: input.fromRosterMemberId, organizationId: input.fromOrganizationId, status: "ACTIVE" },
      select: rosterMemberSelect,
    });
    if (!fromMemberRow || !fromMemberRow.personId) {
      throw new MemberTransferError("MEMBER_NOT_FOUND", "That person isn't active on that club's roster.");
    }
    // Narrowed: every field below reads the same as `fromMemberRow`, but with `personId` known non-null.
    const fromMember = { ...fromMemberRow, personId: fromMemberRow.personId };

    const clubYear = clubYearFor(now);
    const existingAtDestination = await tx.clubRosterMember.findFirst({
      where: { organizationId: toOrganizationId, clubYear, personId: fromMember.personId, status: { not: "REMOVED" } },
      select: { id: true },
    });
    if (existingAtDestination) {
      throw new MemberTransferError("ALREADY_ON_ROSTER", "This person is already on your club's roster.");
    }

    const [fromClub, toClub, person] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: input.fromOrganizationId }, select: { name: true } }),
      tx.organization.findUniqueOrThrow({ where: { id: toOrganizationId }, select: { name: true } }),
      tx.person.findUniqueOrThrow({ where: { id: fromMember.personId }, select: { firstName: true, lastName: true, normalizedEmail: true } }),
    ]);

    const attribution = transferActorAttribution(actor);
    const toMember = await tx.clubRosterMember.create({
      data: {
        organizationId: toOrganizationId,
        clubYear,
        personId: fromMember.personId,
        attendeeType: fromMember.attendeeType,
        role: fromMember.role,
        classLevel: fromMember.classLevel,
        reportedAge: fromMember.reportedAge,
        gender: fromMember.gender,
        sealedBirthDate: fromMember.sealedBirthDate,
        willingToDrive: fromMember.willingToDrive,
        status: "ACTIVE",
        source: "TRANSFER",
        ...("accountId" in attribution ? { createdByAccountId: attribution.accountId } : { createdByUserId: attribution.userId }),
      },
      select: { id: true },
    });

    const transfer = await tx.memberTransfer.create({
      data: {
        personId: fromMember.personId,
        clubYear,
        fromOrganizationId: input.fromOrganizationId,
        toOrganizationId,
        fromRosterMemberId: fromMember.id,
        toRosterMemberId: toMember.id,
        reason: input.reason,
        status: "PENDING",
        initiatedAt: now,
        acknowledgeDueAt: computeAcknowledgeDueAt(now),
        ...("accountId" in attribution ? { initiatedByAccountId: attribution.accountId } : { initiatedByUserId: attribution.userId }),
      },
      select: { id: true },
    });

    await transferEvent(tx, transfer.id, "INITIATED", actor, input.reason, {
      fromOrganizationId: input.fromOrganizationId,
      toOrganizationId,
      fromRosterMemberId: fromMember.id,
      toRosterMemberId: toMember.id,
    });
    await audit(
      tx,
      actor,
      "CLUB_MEMBER_TRANSFER_INITIATED",
      transfer.id,
      `${toClub.name} started a transfer for a member from ${fromClub.name}.`,
      { fromOrganizationId: input.fromOrganizationId, toOrganizationId, personId: fromMember.personId },
    );

    const sendingLeaders = await activeClubLeaders(tx, input.fromOrganizationId, now);
    await queueTransferNotification(
      tx,
      transfer.id,
      "MEMBER_TRANSFER_STARTED",
      sendingLeaders.map((leader) => ({ accountId: leader.id, email: leader.email, name: leader.displayName })),
      transferNotificationEmail({
        templateKey: "MEMBER_TRANSFER_STARTED",
        memberName: `${person.firstName} ${person.lastName}`,
        fromClubName: fromClub.name,
        toClubName: toClub.name,
        reason: input.reason,
      }),
    );

    return { transferId: transfer.id, rosterMemberId: toMember.id };
  });
}

/**
 * Moves an open, club-billed event registration's attendee row from the
 * sending club's registration to the receiving club's (#489). Only a
 * `DEFERRED_ORGANIZATION_INVOICE` (church-billed) registration is touched —
 * clubs pay after the event, so there's no prepayment conflict — and only
 * one whose event hasn't ended yet and is still submitted or confirmed
 * ("open"). Amounts owed are never recalculated here (that's a pricing
 * decision, a human-only gate); finance reconciles from the audit trail this
 * writes. When the receiving club has no open registration of its own for
 * that event yet, the attendee is left in place and the skip is still
 * audited — nothing here creates or prices a new club registration.
 */
async function repointOpenRegistrations(
  tx: Prisma.TransactionClient,
  transferId: string,
  personId: string,
  fromOrganizationId: string,
  toOrganizationId: string,
  actor: TransferActor | null,
  now: Date,
) {
  const attendees = await tx.registrationAttendee.findMany({
    where: {
      personId,
      registration: {
        status: { in: ["SUBMITTED", "CONFIRMED"] },
        clubRegistration: { organizationId: fromOrganizationId },
      },
      event: { billingMode: "DEFERRED_ORGANIZATION_INVOICE", endsAt: { gte: now } },
    },
    select: { id: true, eventId: true, registrationId: true },
  });
  for (const attendee of attendees) {
    const destination = await tx.clubEventRegistration.findUnique({
      where: { eventId_organizationId: { eventId: attendee.eventId, organizationId: toOrganizationId } },
      select: { registrationId: true, registration: { select: { status: true } } },
    });
    if (!destination || destination.registration.status === "CANCELLED") {
      await transferEvent(tx, transferId, "REGISTRATION_REPOINTED", actor, "No open registration at the receiving club for this event yet.", {
        eventId: attendee.eventId,
        outcome: "SKIPPED_NO_RECEIVING_REGISTRATION",
      });
      continue;
    }
    const alreadyThere = await tx.registrationAttendee.findUnique({
      where: { registrationId_personId: { registrationId: destination.registrationId, personId } },
      select: { id: true },
    });
    if (alreadyThere) {
      await transferEvent(tx, transferId, "REGISTRATION_REPOINTED", actor, "Already registered with the receiving club for this event.", {
        eventId: attendee.eventId,
        outcome: "SKIPPED_ALREADY_REGISTERED",
      });
      continue;
    }
    await tx.registrationAttendee.update({
      where: { id: attendee.id },
      data: { registrationId: destination.registrationId },
    });
    await transferEvent(tx, transferId, "REGISTRATION_REPOINTED", actor, "Open event registration re-pointed to the receiving club.", {
      eventId: attendee.eventId,
      fromRegistrationId: attendee.registrationId,
      toRegistrationId: destination.registrationId,
      outcome: "REPOINTED",
    });
    await writeAuditLog({
      eventId: attendee.eventId,
      action: "CLUB_MEMBER_TRANSFER_REGISTRATION_REPOINTED",
      entityType: "RegistrationAttendee",
      entityId: attendee.id,
      summary: "A club member transfer re-pointed an open event registration to the receiving club.",
      metadata: { transferId, fromOrganizationId, toOrganizationId, personId },
    }, tx);
  }
}

async function completeTransfer(
  transferId: string,
  organizationScope: { fromOrganizationId?: string } | null,
  resolution: MemberTransferResolution,
  eventType: "ACKNOWLEDGED" | "STAFF_FINISHED" | "STAFF_OVERRIDDEN",
  note: string,
  actor: TransferActor,
  now: Date,
) {
  return getPrisma().$transaction(async (tx) => {
    const transfer = await tx.memberTransfer.findUnique({
      where: { id: transferId },
      select: {
        id: true, status: true, personId: true, reason: true,
        fromOrganizationId: true, toOrganizationId: true, fromRosterMemberId: true,
      },
    });
    if (!transfer || (organizationScope?.fromOrganizationId && transfer.fromOrganizationId !== organizationScope.fromOrganizationId)) {
      throw new MemberTransferError("TRANSFER_NOT_FOUND", "That transfer could not be found.");
    }
    if (transfer.status !== "PENDING") {
      throw new MemberTransferError("ALREADY_RESOLVED", "This transfer was already resolved.");
    }

    const attribution = transferActorAttribution(actor);
    await tx.clubRosterMember.update({
      where: { id: transfer.fromRosterMemberId },
      data: { status: "REMOVED", removedAt: now },
    });
    await tx.memberTransfer.update({
      where: { id: transferId },
      data: {
        status: "COMPLETED",
        resolution,
        resolvedAt: now,
        staffNote: eventType === "ACKNOWLEDGED" ? undefined : note,
        ...("accountId" in attribution ? { resolvedByAccountId: attribution.accountId } : { resolvedByUserId: attribution.userId }),
      },
    });
    await transferEvent(tx, transferId, eventType, actor, note);
    await audit(
      tx,
      actor,
      `CLUB_MEMBER_TRANSFER_${eventType}`,
      transferId,
      eventType === "ACKNOWLEDGED"
        ? "The sending club acknowledged a member transfer."
        : `Conference staff ${eventType === "STAFF_FINISHED" ? "finished" : "overrode"} a member transfer.`,
      { fromOrganizationId: transfer.fromOrganizationId, toOrganizationId: transfer.toOrganizationId, personId: transfer.personId },
    );

    await repointOpenRegistrations(tx, transferId, transfer.personId, transfer.fromOrganizationId, transfer.toOrganizationId, actor, now);

    const [fromClub, toClub, person, sendingLeaders, receivingLeaders] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: transfer.fromOrganizationId }, select: { name: true } }),
      tx.organization.findUniqueOrThrow({ where: { id: transfer.toOrganizationId }, select: { name: true } }),
      tx.person.findUniqueOrThrow({ where: { id: transfer.personId }, select: { firstName: true, lastName: true, normalizedEmail: true } }),
      activeClubLeaders(tx, transfer.fromOrganizationId, now),
      activeClubLeaders(tx, transfer.toOrganizationId, now),
    ]);
    const content = transferNotificationEmail({
      templateKey: "MEMBER_TRANSFER_COMPLETED",
      memberName: `${person.firstName} ${person.lastName}`,
      fromClubName: fromClub.name,
      toClubName: toClub.name,
      reason: transfer.reason,
    });
    const recipients = [
      ...sendingLeaders.map((leader) => ({ accountId: leader.id, email: leader.email, name: leader.displayName })),
      ...receivingLeaders.map((leader) => ({ accountId: leader.id, email: leader.email, name: leader.displayName })),
      // The member or guardian, if an email is on file (#489) — never a bulk send, just this one person.
      ...(person.normalizedEmail ? [{ email: person.normalizedEmail, name: `${person.firstName} ${person.lastName}` }] : []),
    ];
    await queueTransferNotification(tx, transferId, "MEMBER_TRANSFER_COMPLETED", recipients, content);

    return { transferId };
  });
}

/** The sending club acknowledges a pending transfer (#489). */
export async function acknowledgeTransfer(fromOrganizationId: string, transferId: string, actor: TransferActor, now = new Date()) {
  return completeTransfer(transferId, { fromOrganizationId }, "SENDING_CLUB_ACKNOWLEDGED", "ACKNOWLEDGED", "", actor, now);
}

/** Conference staff finish a transfer the sending club hasn't acknowledged (#489). */
export async function staffFinishTransfer(transferId: string, note: string, actor: TransferActor, now = new Date()) {
  return completeTransfer(transferId, null, "STAFF_FINISHED", "STAFF_FINISHED", note, actor, now);
}

/** Conference staff override a transfer outright (#489) — before or after the 14-day window. */
export async function staffOverrideTransfer(transferId: string, note: string, actor: TransferActor, now = new Date()) {
  return completeTransfer(transferId, null, "STAFF_OVERRIDDEN", "STAFF_OVERRIDDEN", note, actor, now);
}

const transferListSelect = {
  id: true,
  personId: true,
  clubYear: true,
  fromOrganizationId: true,
  toOrganizationId: true,
  reason: true,
  status: true,
  resolution: true,
  staffNote: true,
  initiatedAt: true,
  acknowledgeDueAt: true,
  resolvedAt: true,
  fromOrganization: { select: { name: true } },
  toOrganization: { select: { name: true } },
  person: { select: { firstName: true, lastName: true } },
  events: { select: { id: true, type: true, note: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.MemberTransferSelect;

function serializeTransfer(transfer: Prisma.MemberTransferGetPayload<{ select: typeof transferListSelect }>, now: Date) {
  return {
    id: transfer.id,
    memberName: `${transfer.person.firstName} ${transfer.person.lastName}`,
    clubYear: transfer.clubYear,
    fromOrganizationId: transfer.fromOrganizationId,
    fromOrganizationName: transfer.fromOrganization.name,
    toOrganizationId: transfer.toOrganizationId,
    toOrganizationName: transfer.toOrganization.name,
    reason: transfer.reason,
    status: transfer.status,
    resolution: transfer.resolution,
    staffNote: transfer.staffNote,
    initiatedAt: transfer.initiatedAt.toISOString(),
    acknowledgeDueAt: transfer.acknowledgeDueAt.toISOString(),
    resolvedAt: transfer.resolvedAt?.toISOString() ?? null,
    overdueForStaff: isOverdueForStaffQueue({ status: transfer.status, acknowledgeDueAt: transfer.acknowledgeDueAt }, now),
    events: transfer.events.map((event) => ({ id: event.id, type: event.type, note: event.note, createdAt: event.createdAt.toISOString() })),
  };
}

export type MemberTransferRecord = ReturnType<typeof serializeTransfer>;

/** A club's own transfer history (#489), both directions, newest first — shown on the club's roster. */
export async function listClubTransfers(organizationId: string, now = new Date()) {
  const transfers = await getPrisma().memberTransfer.findMany({
    where: { OR: [{ fromOrganizationId: organizationId }, { toOrganizationId: organizationId }] },
    select: transferListSelect,
    orderBy: { createdAt: "desc" },
  });
  return transfers.map((transfer) => serializeTransfer(transfer, now));
}

/** The conference staff queue (#489): pending transfers the sending club hasn't acknowledged within 14 days. */
export async function listStaffTransferQueue(now = new Date()) {
  const transfers = await getPrisma().memberTransfer.findMany({
    where: { status: "PENDING", acknowledgeDueAt: { lte: now } },
    select: transferListSelect,
    orderBy: { acknowledgeDueAt: "asc" },
  });
  return transfers.map((transfer) => serializeTransfer(transfer, now));
}
