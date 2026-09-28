import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { isAccountEmailConfigured, getAccountEmailSender } from "@/modules/communications/account-email";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { eraseRosterRow } from "@/modules/club-rosters/repository";
import type { StaffTransferActor, TransferActor } from "@/modules/club-transfers/access";
import { transferActorAttribution } from "@/modules/club-transfers/access";
import {
  acknowledgeDueAt as computeAcknowledgeDueAt,
  dedupeNotificationRecipients,
  isOpenTransfer,
  isOverdueForStaffQueue,
  normalizeNotificationEmail,
  openTransferStatuses,
  receivingClubStatusLabel,
  registrationMoveBlocker,
  registrationMoveBlockerLabels,
  sameTransferName,
  sendingClubStatusLabel,
  transferOrganizationsProblem,
  transferReasonProblem,
  type MemberTransferResolution,
  type MemberTransferStaffReason,
  type MemberTransferStatus,
  type RegistrationMoveBlocker,
  type StaffQueueFilter,
} from "@/modules/club-transfers/domain";
import { transferNotificationKey, transferRequestKey } from "@/modules/club-transfers/keys";
import type { RequestTransferInput } from "@/modules/club-transfers/schemas";
import { seatHoldingEnrollment } from "@/modules/honors/enrollment-repository";
import { directorGrantIsActive } from "@/modules/organizations/director-grants-domain";

/**
 * Club member transfer storage (#489, decisions of Sept 28). One
 * append-only `MemberTransferEvent` row per thing that happens is written
 * for every state change, alongside an `AuditLog` entry naming the actor.
 *
 * No medical or insurance data is read or moved anywhere in this module: it
 * never selects `BackgroundCheck` or any insurance field, only roster
 * columns, the sealed birth date (copied, never opened), and registration
 * rows. Birth dates are never in any payload this module returns.
 */

export type MemberTransferErrorCode =
  | "TRANSFER_NOT_FOUND"
  | "CLUB_NOT_FOUND"
  | "SAME_CLUB"
  | "REASON_REQUIRED"
  | "ALREADY_ON_ROSTER"
  | "DUPLICATE_REQUEST"
  | "TRANSFER_ALREADY_PENDING"
  | "ALREADY_RESOLVED"
  | "NOT_PENDING"
  | "NOT_OVERDUE"
  | "SELF_ACKNOWLEDGE_NOT_ALLOWED"
  | "MEMBER_NO_LONGER_ACTIVE"
  | "MEMBER_CHOICE_REQUIRED"
  | "MOVE_NOT_FOUND"
  | "MOVE_ALREADY_DECIDED"
  | "MOVE_BLOCKED"
  | "TRANSFER_CONFLICT";

const statusByCode: Record<MemberTransferErrorCode, 400 | 403 | 404 | 409> = {
  TRANSFER_NOT_FOUND: 404,
  CLUB_NOT_FOUND: 400,
  SAME_CLUB: 400,
  REASON_REQUIRED: 400,
  ALREADY_ON_ROSTER: 409,
  DUPLICATE_REQUEST: 409,
  TRANSFER_ALREADY_PENDING: 409,
  ALREADY_RESOLVED: 409,
  NOT_PENDING: 409,
  NOT_OVERDUE: 409,
  SELF_ACKNOWLEDGE_NOT_ALLOWED: 403,
  MEMBER_NO_LONGER_ACTIVE: 409,
  MEMBER_CHOICE_REQUIRED: 400,
  MOVE_NOT_FOUND: 404,
  MOVE_ALREADY_DECIDED: 409,
  MOVE_BLOCKED: 409,
  TRANSFER_CONFLICT: 409,
};

export class MemberTransferError extends Error {
  public readonly status: 400 | 403 | 404 | 409;
  constructor(public readonly code: MemberTransferErrorCode, message: string, public readonly blocker?: RegistrationMoveBlocker) {
    super(message);
    this.name = "MemberTransferError";
    this.status = statusByCode[code];
  }
}

/** Reads that run inside a transaction or straight on the client. */
type Client = Prisma.TransactionClient | PrismaClient;

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isRetryableTransaction(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002");
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

function attributionFields(actor: TransferActor, prefix: "initiatedBy" | "resolvedBy") {
  const attribution = transferActorAttribution(actor);
  return "accountId" in attribution
    ? { [`${prefix}AccountId`]: attribution.accountId }
    : { [`${prefix}UserId`]: attribution.userId };
}

/** Every audit entry names its actor (#489 N4): a staff user id, or the attendee account in metadata. */
function audit(
  tx: Prisma.TransactionClient,
  actor: TransferActor,
  action: string,
  entityId: string,
  summary: string,
  metadata: Record<string, Prisma.InputJsonValue | null> = {},
  options: { eventId?: string; entityType?: string } = {},
) {
  const attribution = transferActorAttribution(actor);
  return writeAuditLog({
    ...(options.eventId ? { eventId: options.eventId } : {}),
    ...("userId" in attribution ? { actorUserId: attribution.userId } : {}),
    action,
    entityType: options.entityType ?? "MemberTransfer",
    entityId,
    summary,
    metadata: {
      ...("accountId" in attribution ? { actorAttendeeAccountId: attribution.accountId } : {}),
      ...("actAsId" in attribution && attribution.actAsId ? { actAsId: attribution.actAsId } : {}),
      ...metadata,
    },
  }, tx);
}

type TransferEventType =
  | "REQUESTED"
  | "ACCEPTED"
  | "DECLINED"
  | "CANCELLED"
  | "STAFF_FINISHED"
  | "STAFF_OVERRIDDEN"
  | "REGISTRATION_MOVE_QUEUED"
  | "REGISTRATION_MOVE_APPROVED"
  | "REGISTRATION_MOVE_SKIPPED"
  | "NOTIFIED";

function transferEvent(
  tx: Prisma.TransactionClient,
  transferId: string,
  type: TransferEventType,
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
async function activeClubLeaders(tx: Client, organizationId: string, now: Date) {
  const grants = await tx.clubDirectorGrant.findMany({
    where: { organizationId, role: { in: ["DIRECTOR", "DEPUTY"] }, revokedAt: null },
    select: { role: true, effectiveFrom: true, effectiveTo: true, revokedAt: true, attendeeAccount: { select: { id: true, email: true, displayName: true } } },
  });
  return grants
    .filter((grant) => directorGrantIsActive(grant, now))
    .map((grant) => grant.attendeeAccount);
}

async function leadsClub(tx: Client, accountId: string, organizationId: string, now: Date) {
  return (await activeClubLeaders(tx, organizationId, now)).some((leader) => leader.id === accountId);
}

type NotificationTemplate = "MEMBER_TRANSFER_STARTED" | "MEMBER_TRANSFER_COMPLETED";

/**
 * The notice text. Never the free-text reason (#489 B6): a reason can carry
 * family circumstances that don't belong in an inbox, so the email says to
 * sign in for details instead.
 */
export function transferNotificationEmail(input: {
  templateKey: NotificationTemplate;
  memberName: string;
  fromClubName: string;
  toClubName: string;
  /** The same person leads both clubs (#489 N6): conference staff complete it, so the club isn't asked to answer. */
  staffCompletes?: boolean;
}) {
  if (input.templateKey === "MEMBER_TRANSFER_STARTED" && input.staffCompletes) {
    return {
      subject: `${input.toClubName} asked to transfer a member`,
      bodyText: [
        `${input.toClubName} has asked to transfer ${input.memberName} from ${input.fromClubName} on IMSDA Events.`,
        "",
        "The same person leads both clubs, so conference staff will complete this transfer. There is nothing for you to accept or decline. Sign in to see the details.",
        "",
        "IMSDA Events",
      ].join("\n"),
    };
  }
  if (input.templateKey === "MEMBER_TRANSFER_STARTED") {
    return {
      subject: `${input.toClubName} asked to transfer a member`,
      bodyText: [
        `${input.toClubName} has asked to transfer ${input.memberName} from ${input.fromClubName} on IMSDA Events.`,
        "",
        `Sign in to see the details and accept or decline it from ${input.fromClubName}'s roster. If it isn't answered within 14 days, conference staff will follow up.`,
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
      "Sign in to see the details.",
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

type NotificationRecipient = { accountId?: string; email: string; name?: string | null };

/**
 * Queues one notice per distinct recipient (#489 B6): deduped by normalized
 * email, keyed by transfer, template and account (or a hash of the email,
 * never the email itself), and written with `skipDuplicates` so a repeat
 * can never fail the transaction that completes a transfer.
 */
async function queueTransferNotification(
  tx: Prisma.TransactionClient,
  transferId: string,
  templateKey: NotificationTemplate,
  recipients: NotificationRecipient[],
  content: { subject: string; bodyText: string },
) {
  // Best-effort, same as the club team role notice: the transfer stands even
  // where account email isn't configured (local dev). Never a bulk send:
  // one message per person party to this one transfer.
  if (!isAccountEmailConfigured()) return;
  const unique = dedupeNotificationRecipients(recipients.filter((recipient) => Boolean(recipient.email)));
  if (unique.length === 0) return;
  const sender = getAccountEmailSender();
  const created = await tx.messageOutbox.createMany({
    skipDuplicates: true,
    data: unique.map((recipient) => ({
      eventId: null,
      templateKey,
      recipientKind: "ACCOUNT" as const,
      recipientEmail: normalizeNotificationEmail(recipient.email),
      recipientName: recipient.name ?? null,
      accountAttendeeId: recipient.accountId ?? null,
      senderNameSnapshot: sender.name,
      senderEmailSnapshot: sender.address,
      replyToEmailSnapshot: sender.replyTo,
      subjectSnapshot: content.subject,
      bodyTextSnapshot: content.bodyText,
      metadata: { trigger: templateKey, transferId, accountEmail: true, realDelivery: true },
      idempotencyKey: transferNotificationKey(transferId, templateKey, recipient),
      correlationId: transferId,
      status: "PENDING" as const,
    })),
  });
  await transferEvent(tx, transferId, "NOTIFIED", null, `${templateKey} queued to ${created.count} recipient(s).`, { templateKey, count: created.count });
}

function leaderRecipients(leaders: Array<{ id: string; email: string; displayName: string | null }>): NotificationRecipient[] {
  return leaders.map((leader) => ({ accountId: leader.id, email: leader.email, name: leader.displayName }));
}

/** Active clubs a director may name as the member's current club (the club picker). No roster data. */
export async function listTransferClubOptions(excludingOrganizationId: string) {
  return getPrisma().organization.findMany({
    where: { type: "CLUB", isActive: true, id: { not: excludingOrganizationId } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/**
 * The receiving club's director requests a transfer (#489 decision 1). The
 * answer is the same whether or not the name matches anyone: a transfer row
 * is always written, `PENDING` for exactly one match (the sending club is
 * asked) or `UNMATCHED` otherwise (conference staff are). The only refusals
 * are about what the requesting club already knows: its own roster, and its
 * own open request for the same name and club.
 */
export async function requestTransfer(
  toOrganizationId: string,
  input: RequestTransferInput,
  actor: TransferActor,
  now = new Date(),
) {
  const reasonProblem = transferReasonProblem(input.reason);
  if (reasonProblem) throw new MemberTransferError("REASON_REQUIRED", reasonProblem);
  const orgProblem = transferOrganizationsProblem(input.fromOrganizationId, toOrganizationId);
  if (orgProblem) throw new MemberTransferError("SAME_CLUB", orgProblem);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestTransferOnce(toOrganizationId, input, actor, now);
    } catch (error) {
      // A racing request for the same person or the same typed name lost the
      // unique index: one more pass sees the winner and answers the way a
      // later request would (a duplicate, or a request routed to staff).
      if (isUniqueViolation(error) && attempt === 0) continue;
      if (isUniqueViolation(error)) {
        throw new MemberTransferError("DUPLICATE_REQUEST", "You already have an open transfer request for this person from that club.");
      }
      throw error;
    }
  }
}

async function requestTransferOnce(toOrganizationId: string, input: RequestTransferInput, actor: TransferActor, now: Date) {
  const clubYear = clubYearFor(now);
  return getPrisma().$transaction(async (tx) => {
    const [fromClub, toClub] = await Promise.all([
      tx.organization.findFirst({ where: { id: input.fromOrganizationId, type: "CLUB", isActive: true }, select: { id: true, name: true } }),
      tx.organization.findUniqueOrThrow({ where: { id: toOrganizationId }, select: { name: true } }),
    ]);
    if (!fromClub) throw new MemberTransferError("CLUB_NOT_FOUND", "Choose the member's current club from the list.");

    // Only the requesting club's own roster is consulted here, so this can't reveal anything about the other club.
    const ownRoster = await tx.clubRosterMember.findMany({
      where: { organizationId: toOrganizationId, clubYear, status: { not: "REMOVED" }, personId: { not: null } },
      select: { person: { select: { firstName: true, lastName: true } } },
    });
    if (ownRoster.some((row) => row.person && sameTransferName(row.person, input))) {
      throw new MemberTransferError("ALREADY_ON_ROSTER", "Someone with this name is already on your club's roster.");
    }

    const requestKey = transferRequestKey({ toOrganizationId, fromOrganizationId: fromClub.id, firstName: input.firstName, lastName: input.lastName });
    const duplicate = await tx.memberTransfer.findUnique({ where: { requestKey }, select: { id: true } });
    if (duplicate) {
      throw new MemberTransferError("DUPLICATE_REQUEST", "You already have an open transfer request for this person from that club.");
    }

    // Exact normalized names, current club year, active rows only (#489 N5).
    const candidates = await tx.clubRosterMember.findMany({
      where: { organizationId: fromClub.id, clubYear, status: "ACTIVE", personId: { not: null } },
      select: { id: true, personId: true, person: { select: { firstName: true, lastName: true } } },
    });
    const matches = candidates.filter((row) => row.person && sameTransferName(row.person, input));

    let status: MemberTransferStatus = "UNMATCHED";
    let staffReason: MemberTransferStaffReason | null = null;
    let personId: string | null = null;
    let fromRosterMemberId: string | null = null;
    if (matches.length === 0) {
      staffReason = "NO_MATCH";
    } else if (matches.length > 1) {
      staffReason = "AMBIGUOUS_MATCH";
    } else {
      const match = matches[0]!;
      personId = match.personId;
      fromRosterMemberId = match.id;
      const otherOpen = await tx.memberTransfer.findUnique({ where: { pendingPersonId: match.personId! }, select: { id: true } });
      if (otherOpen) {
        staffReason = "ALREADY_PENDING";
      } else {
        status = "PENDING";
        // N6: a director of both clubs never acknowledges their own request; staff complete it.
        if (actor && "kind" in actor && actor.kind === "ATTENDEE" && await leadsClub(tx, actor.accountId, fromClub.id, now)) {
          staffReason = "SAME_DIRECTOR";
        }
      }
    }

    const transfer = await tx.memberTransfer.create({
      data: {
        personId,
        pendingPersonId: status === "PENDING" ? personId : null,
        requestKey,
        clubYear,
        fromOrganizationId: fromClub.id,
        toOrganizationId,
        fromRosterMemberId,
        requestedFirstName: input.firstName.trim(),
        requestedLastName: input.lastName.trim(),
        reason: input.reason.trim(),
        status,
        staffReason,
        sendingClubVisible: status === "PENDING",
        initiatedAt: now,
        acknowledgeDueAt: computeAcknowledgeDueAt(now),
        ...attributionFields(actor, "initiatedBy"),
      },
      select: { id: true },
    });

    await transferEvent(tx, transfer.id, "REQUESTED", actor, input.reason.trim(), { status, staffReason });
    await audit(
      tx,
      actor,
      "CLUB_MEMBER_TRANSFER_REQUESTED",
      transfer.id,
      `${toClub.name} requested a member transfer from ${fromClub.name}.`,
      { fromOrganizationId: fromClub.id, toOrganizationId, outcome: status, staffReason },
    );

    // The sending club's notice is queued separately, after this commits and
    // after the response is sent (`queueTransferRequestNotice`), so a matched
    // request takes no longer to answer than an unmatched one.
    return { transferId: transfer.id };
  });
}

/**
 * Queues the sending club's "a transfer was requested" notice (#489), for a
 * matched request only; an unmatched one sends nothing. Called for every
 * request after the response is sent, so the answer's timing never depends
 * on whether the name matched. Idempotent: the outbox keys dedupe a repeat.
 */
export async function queueTransferRequestNotice(transferId: string, now = new Date()) {
  await getPrisma().$transaction(async (tx) => {
    const transfer = await tx.memberTransfer.findUnique({
      where: { id: transferId },
      select: {
        status: true, staffReason: true, fromOrganizationId: true,
        fromOrganization: { select: { name: true } }, toOrganization: { select: { name: true } },
        person: { select: { firstName: true, lastName: true } },
      },
    });
    if (!transfer || transfer.status !== "PENDING" || !transfer.person) return;
    const sendingLeaders = await activeClubLeaders(tx, transfer.fromOrganizationId, now);
    await queueTransferNotification(
      tx,
      transferId,
      "MEMBER_TRANSFER_STARTED",
      leaderRecipients(sendingLeaders),
      transferNotificationEmail({
        templateKey: "MEMBER_TRANSFER_STARTED",
        memberName: `${transfer.person.firstName} ${transfer.person.lastName}`,
        fromClubName: transfer.fromOrganization.name,
        toClubName: transfer.toOrganization.name,
        staffCompletes: transfer.staffReason === "SAME_DIRECTOR",
      }),
    );
  });
}

const transferCoreSelect = {
  id: true,
  status: true,
  staffReason: true,
  personId: true,
  clubYear: true,
  fromOrganizationId: true,
  toOrganizationId: true,
  fromRosterMemberId: true,
  sendingClubVisible: true,
  acknowledgeDueAt: true,
  initiatedByAccountId: true,
  initiatedByUserId: true,
} satisfies Prisma.MemberTransferSelect;

type TransferCore = Prisma.MemberTransferGetPayload<{ select: typeof transferCoreSelect }>;

async function loadTransfer(tx: Prisma.TransactionClient, transferId: string) {
  const transfer = await tx.memberTransfer.findUnique({ where: { id: transferId }, select: transferCoreSelect });
  if (!transfer) throw new MemberTransferError("TRANSFER_NOT_FOUND", "That transfer could not be found.");
  return transfer;
}

/** A sending club only ever reaches a request it was shown. Anything else reads as not found. */
function assertSendingClub(transfer: TransferCore, organizationId: string) {
  if (transfer.fromOrganizationId !== organizationId || !transfer.sendingClubVisible) {
    throw new MemberTransferError("TRANSFER_NOT_FOUND", "That transfer could not be found.");
  }
}

/**
 * The completion core, shared by the sending club's acceptance and staff's
 * finish or override. Guarded by a status-conditional update (#489 N1), so
 * two racing completions can't both succeed. Inside the same transaction:
 * the sending row is re-checked (still active, this club year: B5, N5),
 * erased exactly as a removal erases it (B2), and the receiving row is
 * created with the roster fields and the sealed birth date (never opened).
 * Registration moves are only queued for staff; none happens here.
 */
async function completeTransfer(
  tx: Prisma.TransactionClient,
  transfer: TransferCore,
  options: {
    allowedStatuses: MemberTransferStatus[];
    resolution: MemberTransferResolution;
    eventType: "ACCEPTED" | "STAFF_FINISHED" | "STAFF_OVERRIDDEN";
    note: string;
    actor: TransferActor;
    now: Date;
    fromRosterMemberId?: string;
  },
) {
  const { actor, now } = options;
  const guard = await tx.memberTransfer.updateMany({
    where: { id: transfer.id, status: { in: options.allowedStatuses } },
    data: { status: "COMPLETED" },
  });
  if (guard.count !== 1) throw new MemberTransferError("ALREADY_RESOLVED", "This transfer was already resolved.");

  const sendingRowId = options.fromRosterMemberId ?? transfer.fromRosterMemberId;
  if (!sendingRowId) throw new MemberTransferError("MEMBER_CHOICE_REQUIRED", "Choose which member of the sending club this request is for.");
  const sending = await tx.clubRosterMember.findUnique({ where: { id: sendingRowId }, select: rosterMemberSelect });
  const clubYear = clubYearFor(now);
  if (
    !sending
    || sending.organizationId !== transfer.fromOrganizationId
    || sending.status !== "ACTIVE"
    || sending.clubYear !== clubYear
    || !sending.personId
    || (transfer.personId && !options.fromRosterMemberId && sending.personId !== transfer.personId)
  ) {
    throw new MemberTransferError(
      "MEMBER_NO_LONGER_ACTIVE",
      "That member is no longer active on the sending club's roster for this club year, so the transfer can't be completed. Cancel it instead.",
    );
  }
  const personId = sending.personId;

  const otherOpen = await tx.memberTransfer.findFirst({
    where: { pendingPersonId: personId, id: { not: transfer.id } },
    select: { id: true },
  });
  if (otherOpen) {
    throw new MemberTransferError("TRANSFER_ALREADY_PENDING", "This member has another open transfer. Resolve that one first.");
  }
  const alreadyThere = await tx.clubRosterMember.findFirst({
    where: { organizationId: transfer.toOrganizationId, clubYear, personId, status: { not: "REMOVED" } },
    select: { id: true },
  });
  if (alreadyThere) throw new MemberTransferError("ALREADY_ON_ROSTER", "This member is already on the receiving club's roster.");

  // The birth date moves: it is read sealed from the sending row, the
  // sending row is erased, and only then is the receiving row written. No
  // copy stays behind at the sending club.
  await eraseRosterRow(tx, sending.id, now);
  const attribution = transferActorAttribution(actor);
  const receiving = await tx.clubRosterMember.create({
    data: {
      organizationId: transfer.toOrganizationId,
      clubYear,
      personId,
      attendeeType: sending.attendeeType,
      role: sending.role,
      classLevel: sending.classLevel,
      reportedAge: sending.reportedAge,
      gender: sending.gender,
      sealedBirthDate: sending.sealedBirthDate,
      willingToDrive: sending.willingToDrive,
      status: "ACTIVE",
      source: "TRANSFER",
      ...("accountId" in attribution ? { createdByAccountId: attribution.accountId } : { createdByUserId: attribution.userId }),
    },
    select: { id: true },
  });

  const staffResolution = options.eventType !== "ACCEPTED";
  await tx.memberTransfer.update({
    where: { id: transfer.id },
    data: {
      personId,
      fromRosterMemberId: sending.id,
      toRosterMemberId: receiving.id,
      pendingPersonId: null,
      requestKey: null,
      sendingClubVisible: true,
      resolution: options.resolution,
      resolvedAt: now,
      ...(staffResolution ? { staffNote: options.note } : {}),
      ...attributionFields(actor, "resolvedBy"),
    },
  });
  await transferEvent(tx, transfer.id, options.eventType, actor, options.note, {
    fromRosterMemberId: sending.id,
    toRosterMemberId: receiving.id,
  });
  await audit(
    tx,
    actor,
    `CLUB_MEMBER_TRANSFER_${options.eventType}`,
    transfer.id,
    options.eventType === "ACCEPTED"
      ? "The sending club accepted a member transfer."
      : `Conference staff ${options.eventType === "STAFF_FINISHED" ? "finished" : "overrode"} a member transfer.`,
    {
      fromOrganizationId: transfer.fromOrganizationId,
      toOrganizationId: transfer.toOrganizationId,
      fromRosterMemberId: sending.id,
      toRosterMemberId: receiving.id,
    },
  );

  await skipSupersededMoves(tx, transfer.id, personId, actor, now);
  const moves = await queueRegistrationMoves(tx, transfer.id, personId, transfer.fromOrganizationId, actor, now);

  const [fromClub, toClub, person, sendingLeaders, receivingLeaders] = await Promise.all([
    tx.organization.findUniqueOrThrow({ where: { id: transfer.fromOrganizationId }, select: { name: true } }),
    tx.organization.findUniqueOrThrow({ where: { id: transfer.toOrganizationId }, select: { name: true } }),
    tx.person.findUniqueOrThrow({ where: { id: personId }, select: { firstName: true, lastName: true, normalizedEmail: true } }),
    activeClubLeaders(tx, transfer.fromOrganizationId, now),
    activeClubLeaders(tx, transfer.toOrganizationId, now),
  ]);
  await queueTransferNotification(
    tx,
    transfer.id,
    "MEMBER_TRANSFER_COMPLETED",
    [
      ...leaderRecipients(sendingLeaders),
      ...leaderRecipients(receivingLeaders),
      // The member or guardian, if an email is on file (#489): just this one person.
      ...(person.normalizedEmail ? [{ email: person.normalizedEmail, name: `${person.firstName} ${person.lastName}` }] : []),
    ],
    transferNotificationEmail({
      templateKey: "MEMBER_TRANSFER_COMPLETED",
      memberName: `${person.firstName} ${person.lastName}`,
      fromClubName: fromClub.name,
      toClubName: toClub.name,
    }),
  );

  return { transferId: transfer.id, rosterMemberId: receiving.id, registrationMovesQueued: moves };
}

const SUPERSEDED_NOTE = "Skipped automatically: a later transfer for this member completed.";

/**
 * A later transfer for the same person completed (#489): any move still
 * pending from an earlier transfer would send their registration to a club
 * they have already left, so it is skipped here, audited, and never left
 * for staff to approve by mistake.
 */
async function skipSupersededMoves(tx: Prisma.TransactionClient, transferId: string, personId: string, actor: TransferActor, now: Date) {
  const stale = await tx.memberTransferRegistrationMove.findMany({
    where: { status: "PENDING", transferId: { not: transferId }, attendee: { personId } },
    select: { id: true, transferId: true, eventId: true, registrationAttendeeId: true, fromRegistrationId: true },
  });
  if (stale.length === 0) return;
  const attribution = transferActorAttribution(actor);
  await tx.memberTransferRegistrationMove.updateMany({
    where: { id: { in: stale.map((move) => move.id) }, status: "PENDING" },
    data: {
      status: "SKIPPED",
      decidedAt: now,
      note: SUPERSEDED_NOTE,
      ...("userId" in attribution ? { decidedByUserId: attribution.userId } : {}),
    },
  });
  for (const move of stale) {
    await transferEvent(tx, move.transferId, "REGISTRATION_MOVE_SKIPPED", actor, SUPERSEDED_NOTE, {
      eventId: move.eventId, moveId: move.id, automatic: true, supersededByTransferId: transferId,
    });
    await audit(
      tx,
      actor,
      "CLUB_MEMBER_TRANSFER_REGISTRATION_MOVE_SKIPPED",
      move.registrationAttendeeId ?? move.id,
      "A pending registration move was skipped automatically because a later transfer for the same member completed.",
      { transferId: move.transferId, moveId: move.id, fromRegistrationId: move.fromRegistrationId, automatic: true, supersededByTransferId: transferId },
      { eventId: move.eventId, entityType: "RegistrationAttendee" },
    );
  }
}

/**
 * Queues each of the member's open, club-billed registrations for staff
 * approval (#489 decision 2). "Open" is a submitted or confirmed
 * registration of the sending club, for a club-billed event that hasn't
 * ended. Nothing moves here.
 */
async function queueRegistrationMoves(
  tx: Prisma.TransactionClient,
  transferId: string,
  personId: string,
  fromOrganizationId: string,
  actor: TransferActor,
  now: Date,
) {
  const attendees = await tx.registrationAttendee.findMany({
    where: {
      personId,
      registration: { status: { in: ["SUBMITTED", "CONFIRMED"] }, clubRegistration: { organizationId: fromOrganizationId } },
      event: { billingMode: "DEFERRED_ORGANIZATION_INVOICE", endsAt: { gte: now } },
    },
    select: { id: true, eventId: true, registrationId: true },
  });
  if (attendees.length === 0) return 0;
  await tx.memberTransferRegistrationMove.createMany({
    skipDuplicates: true,
    data: attendees.map((attendee) => ({
      transferId,
      eventId: attendee.eventId,
      registrationAttendeeId: attendee.id,
      fromRegistrationId: attendee.registrationId,
    })),
  });
  for (const attendee of attendees) {
    await transferEvent(tx, transferId, "REGISTRATION_MOVE_QUEUED", actor, "", {
      eventId: attendee.eventId,
      fromRegistrationId: attendee.registrationId,
    });
  }
  await audit(tx, actor, "CLUB_MEMBER_TRANSFER_REGISTRATION_MOVES_QUEUED", transferId, "Queued a transferred member's open club registrations for staff approval.", {
    count: attendees.length,
  });
  return attendees.length;
}

/** The sending club accepts a pending request (#489). Never self-acknowledgment (N6). */
export async function acceptTransfer(fromOrganizationId: string, transferId: string, actor: TransferActor, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const transfer = await loadTransfer(tx, transferId);
    assertSendingClub(transfer, fromOrganizationId);
    if (transfer.status !== "PENDING") throw new MemberTransferError("NOT_PENDING", "This transfer is no longer waiting on your club.");
    const selfAcknowledge = transfer.staffReason === "SAME_DIRECTOR"
      || ("kind" in actor && actor.kind === "ATTENDEE" && (
        transfer.initiatedByAccountId === actor.accountId || await leadsClub(tx, actor.accountId, transfer.toOrganizationId, now)
      ))
      || ("kind" in actor && actor.kind === "STAFF_ACTING" && transfer.initiatedByUserId === actor.userId);
    if (selfAcknowledge) {
      throw new MemberTransferError(
        "SELF_ACKNOWLEDGE_NOT_ALLOWED",
        "You lead both clubs, so conference staff will complete this transfer.",
      );
    }
    return completeTransfer(tx, transfer, {
      allowedStatuses: ["PENDING"],
      resolution: "SENDING_CLUB_ACCEPTED",
      eventType: "ACCEPTED",
      note: "",
      actor,
      now,
    });
  });
}

/** The sending club declines (#489): the request goes to conference staff, still open. */
export async function declineTransfer(fromOrganizationId: string, transferId: string, note: string, actor: TransferActor, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const transfer = await loadTransfer(tx, transferId);
    assertSendingClub(transfer, fromOrganizationId);
    const guard = await tx.memberTransfer.updateMany({
      where: { id: transferId, status: "PENDING" },
      data: { status: "DECLINED", declinedAt: now },
    });
    if (guard.count !== 1) throw new MemberTransferError("NOT_PENDING", "This transfer is no longer waiting on your club.");
    await transferEvent(tx, transferId, "DECLINED", actor, note);
    await audit(tx, actor, "CLUB_MEMBER_TRANSFER_DECLINED", transferId, "The sending club declined a member transfer; it went to conference staff.", {
      fromOrganizationId: transfer.fromOrganizationId,
      toOrganizationId: transfer.toOrganizationId,
    });
    return { transferId };
  });
}

async function cancel(
  tx: Prisma.TransactionClient,
  transfer: TransferCore,
  allowedStatuses: MemberTransferStatus[],
  note: string,
  actor: TransferActor,
  now: Date,
  cancelledBy: "RECEIVING_CLUB" | "SENDING_CLUB" | "STAFF",
) {
  const guard = await tx.memberTransfer.updateMany({
    where: { id: transfer.id, status: { in: allowedStatuses } },
    data: {
      status: "CANCELLED",
      pendingPersonId: null,
      requestKey: null,
      resolvedAt: now,
      ...(cancelledBy === "STAFF" ? { staffNote: note } : {}),
      ...attributionFields(actor, "resolvedBy"),
    },
  });
  if (guard.count !== 1) throw new MemberTransferError("NOT_PENDING", "This transfer is no longer open.");
  await transferEvent(tx, transfer.id, "CANCELLED", actor, note, { cancelledBy });
  await audit(tx, actor, "CLUB_MEMBER_TRANSFER_CANCELLED", transfer.id, "A member transfer was cancelled.", {
    fromOrganizationId: transfer.fromOrganizationId,
    toOrganizationId: transfer.toOrganizationId,
    cancelledBy,
  });
  return { transferId: transfer.id };
}

/**
 * Either club cancels while the transfer is open (#489): the receiving club
 * any open request of its own (it can't tell pending from unmatched), the
 * sending club only one still waiting on it.
 */
export async function cancelTransferByClub(organizationId: string, transferId: string, note: string, actor: TransferActor, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const transfer = await loadTransfer(tx, transferId);
    if (transfer.toOrganizationId === organizationId) {
      return cancel(tx, transfer, [...openTransferStatuses], note, actor, now, "RECEIVING_CLUB");
    }
    assertSendingClub(transfer, organizationId);
    return cancel(tx, transfer, ["PENDING"], note, actor, now, "SENDING_CLUB");
  });
}

/** Conference staff finish a transfer the sending club hasn't answered within 14 days (#489 N2: only once overdue). */
export async function staffFinishTransfer(transferId: string, note: string, actor: StaffTransferActor, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const transfer = await loadTransfer(tx, transferId);
    if (transfer.status !== "PENDING") throw new MemberTransferError("NOT_PENDING", "Only a request still waiting on the sending club can be finished. Use override instead.");
    if (!isOverdueForStaffQueue(transfer, now)) {
      throw new MemberTransferError("NOT_OVERDUE", "This request isn't overdue yet. Override it with a note if it can't wait.");
    }
    return completeTransfer(tx, transfer, {
      allowedStatuses: ["PENDING"],
      resolution: "STAFF_FINISHED",
      eventType: "STAFF_FINISHED",
      note,
      actor,
      now,
    });
  });
}

/**
 * Conference staff override any open transfer, at any time, with a note
 * (#489 N2): a decline, an unmatched request (staff choose the sending
 * club's roster row), or one routed to staff because the same person leads
 * both clubs.
 */
export async function staffOverrideTransfer(
  transferId: string,
  input: { note: string; fromRosterMemberId?: string },
  actor: StaffTransferActor,
  now = new Date(),
) {
  if (!input.note.trim()) throw new MemberTransferError("REASON_REQUIRED", "Enter a note explaining the override.");
  return getPrisma().$transaction(async (tx) => {
    const transfer = await loadTransfer(tx, transferId);
    if (!isOpenTransfer(transfer.status)) throw new MemberTransferError("ALREADY_RESOLVED", "This transfer was already resolved.");
    if (transfer.status === "UNMATCHED" && !input.fromRosterMemberId) {
      throw new MemberTransferError("MEMBER_CHOICE_REQUIRED", "Choose which member of the sending club this request is for.");
    }
    return completeTransfer(tx, transfer, {
      allowedStatuses: [...openTransferStatuses],
      resolution: "STAFF_OVERRIDDEN",
      eventType: "STAFF_OVERRIDDEN",
      note: input.note.trim(),
      actor,
      now,
      fromRosterMemberId: transfer.status === "UNMATCHED" ? input.fromRosterMemberId : undefined,
    });
  });
}

/** Conference staff close an open request without moving anyone (for example, an unmatched name). */
export async function staffCancelTransfer(transferId: string, note: string, actor: StaffTransferActor, now = new Date()) {
  if (!note.trim()) throw new MemberTransferError("REASON_REQUIRED", "Enter a note explaining why this is closed.");
  return getPrisma().$transaction(async (tx) => {
    const transfer = await loadTransfer(tx, transferId);
    return cancel(tx, transfer, [...openTransferStatuses], note.trim(), actor, now, "STAFF");
  });
}

const clubListSelect = {
  id: true,
  status: true,
  staffReason: true,
  fromOrganizationId: true,
  toOrganizationId: true,
  requestedFirstName: true,
  requestedLastName: true,
  reason: true,
  initiatedAt: true,
  acknowledgeDueAt: true,
  resolvedAt: true,
  resolution: true,
  initiatedByAccountId: true,
  initiatedByUserId: true,
  fromOrganization: { select: { name: true } },
  toOrganization: { select: { name: true } },
  person: { select: { firstName: true, lastName: true } },
  events: { select: { id: true, type: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.MemberTransferSelect;

type ClubListTransfer = Prisma.MemberTransferGetPayload<{ select: typeof clubListSelect }>;

/** Event types a club is shown in its history: what happened, never staff's routing or notes. */
function clubVisibleEvents(transfer: ClubListTransfer, side: "RECEIVING" | "SENDING") {
  const shown = side === "SENDING"
    ? new Set(["REQUESTED", "ACCEPTED", "DECLINED", "CANCELLED", "STAFF_FINISHED", "STAFF_OVERRIDDEN"])
    : new Set(["REQUESTED", "ACCEPTED", "CANCELLED", "STAFF_FINISHED", "STAFF_OVERRIDDEN"]);
  return transfer.events
    .filter((event) => shown.has(event.type))
    .map((event) => ({
      id: event.id,
      // The receiving club reads every completion the same way.
      type: side === "RECEIVING" && (event.type === "ACCEPTED" || event.type === "STAFF_FINISHED" || event.type === "STAFF_OVERRIDDEN")
        ? "COMPLETED"
        : event.type,
      createdAt: event.createdAt.toISOString(),
    }));
}

function typedName(transfer: ClubListTransfer) {
  const name = `${transfer.requestedFirstName} ${transfer.requestedLastName}`.trim();
  // Once the person is erased, the request keeps no name at all.
  return name || "Request closed";
}

function serializeIncoming(transfer: ClubListTransfer) {
  const open = isOpenTransfer(transfer.status);
  return {
    id: transfer.id,
    direction: "INCOMING" as const,
    /** Only the name this club typed itself: never the sending club's record. */
    memberName: typedName(transfer),
    otherClubName: transfer.fromOrganization.name,
    reason: transfer.reason,
    status: open ? "PENDING" as const : transfer.status,
    statusLabel: receivingClubStatusLabel(transfer.status),
    initiatedAt: transfer.initiatedAt.toISOString(),
    resolvedAt: transfer.resolvedAt?.toISOString() ?? null,
    canAccept: false,
    canDecline: false,
    canCancel: open,
    events: clubVisibleEvents(transfer, "RECEIVING"),
  };
}

function serializeOutgoing(transfer: ClubListTransfer, viewer: { accountId?: string; userId?: string }, leadsReceiving: boolean) {
  const pending = transfer.status === "PENDING";
  const selfAcknowledge = transfer.staffReason === "SAME_DIRECTOR"
    || leadsReceiving
    || (viewer.accountId !== undefined && transfer.initiatedByAccountId === viewer.accountId)
    || (viewer.userId !== undefined && transfer.initiatedByUserId === viewer.userId);
  return {
    id: transfer.id,
    direction: "OUTGOING" as const,
    memberName: transfer.person ? `${transfer.person.firstName} ${transfer.person.lastName}` : typedName(transfer),
    otherClubName: transfer.toOrganization.name,
    reason: transfer.reason,
    status: transfer.status,
    statusLabel: pending && selfAcknowledge ? "With conference staff" : sendingClubStatusLabel(transfer.status),
    initiatedAt: transfer.initiatedAt.toISOString(),
    acknowledgeDueAt: transfer.acknowledgeDueAt.toISOString(),
    resolvedAt: transfer.resolvedAt?.toISOString() ?? null,
    canAccept: pending && !selfAcknowledge,
    canDecline: pending,
    canCancel: pending,
    events: clubVisibleEvents(transfer, "SENDING"),
  };
}

export type ClubTransferRecord = ReturnType<typeof serializeIncoming> | ReturnType<typeof serializeOutgoing>;

/**
 * A club's own transfers (#489): requests it made (incoming members) and
 * requests made of it (outgoing members), open ones first, then history.
 * The sending side only ever sees requests it was shown (a match). Never a
 * birth date or age.
 */
export async function listClubTransfers(organizationId: string, actor: TransferActor, now = new Date()) {
  const [incoming, outgoing] = await Promise.all([
    getPrisma().memberTransfer.findMany({
      where: { toOrganizationId: organizationId },
      select: clubListSelect,
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    getPrisma().memberTransfer.findMany({
      where: { fromOrganizationId: organizationId, sendingClubVisible: true },
      select: clubListSelect,
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);
  const attribution = transferActorAttribution(actor);
  const viewer = "accountId" in attribution ? { accountId: attribution.accountId } : { userId: attribution.userId };
  const leadsByClub = new Map<string, boolean>();
  if (viewer.accountId) {
    const pendingReceivers = [...new Set(outgoing.filter((transfer) => transfer.status === "PENDING").map((transfer) => transfer.toOrganizationId))];
    await Promise.all(pendingReceivers.map(async (receiverId) => {
      leadsByClub.set(receiverId, await leadsClub(getPrisma(), viewer.accountId!, receiverId, now));
    }));
  }
  return {
    incoming: incoming.map(serializeIncoming),
    outgoing: outgoing.map((transfer) => serializeOutgoing(transfer, viewer, leadsByClub.get(transfer.toOrganizationId) ?? false)),
  };
}

const staffListSelect = {
  ...clubListSelect,
  staffNote: true,
  declinedAt: true,
  fromRosterMemberId: true,
  events: { select: { id: true, type: true, note: true, createdAt: true, actorUser: { select: { displayName: true } }, actorAccount: { select: { displayName: true } } }, orderBy: { createdAt: "asc" as const } },
  registrationMoves: { select: { id: true, status: true } },
} satisfies Prisma.MemberTransferSelect;

function serializeStaff(transfer: Prisma.MemberTransferGetPayload<{ select: typeof staffListSelect }>, now: Date) {
  const overdue = isOverdueForStaffQueue({ status: transfer.status, acknowledgeDueAt: transfer.acknowledgeDueAt }, now);
  const open = isOpenTransfer(transfer.status);
  return {
    id: transfer.id,
    requestedName: `${transfer.requestedFirstName} ${transfer.requestedLastName}`.trim() || "Erased member",
    matchedMemberName: transfer.person ? `${transfer.person.firstName} ${transfer.person.lastName}` : null,
    fromOrganizationId: transfer.fromOrganizationId,
    fromOrganizationName: transfer.fromOrganization.name,
    toOrganizationId: transfer.toOrganizationId,
    toOrganizationName: transfer.toOrganization.name,
    reason: transfer.reason,
    status: transfer.status,
    staffReason: transfer.staffReason,
    resolution: transfer.resolution,
    staffNote: transfer.staffNote,
    initiatedAt: transfer.initiatedAt.toISOString(),
    acknowledgeDueAt: transfer.acknowledgeDueAt.toISOString(),
    declinedAt: transfer.declinedAt?.toISOString() ?? null,
    resolvedAt: transfer.resolvedAt?.toISOString() ?? null,
    overdue,
    canFinish: overdue,
    canOverride: open,
    canCancel: open,
    needsMemberChoice: transfer.status === "UNMATCHED",
    pendingRegistrationMoves: transfer.registrationMoves.filter((move) => move.status === "PENDING").length,
    events: transfer.events.map((event) => ({
      id: event.id,
      type: event.type,
      note: event.note,
      actorName: event.actorUser?.displayName ?? event.actorAccount?.displayName ?? null,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

export type StaffTransferRecord = ReturnType<typeof serializeStaff>;

function staffQueueWhere(filter: StaffQueueFilter, now: Date): Prisma.MemberTransferWhereInput {
  switch (filter) {
    case "overdue": return { status: "PENDING", acknowledgeDueAt: { lte: now } };
    case "declined": return { status: "DECLINED" };
    case "unmatched": return { status: "UNMATCHED" };
    case "pending": return { status: "PENDING" };
    case "open": return { status: { in: [...openTransferStatuses] } };
  }
}

/** The conference staff queue (#489): overdue, declined, unmatched, pending, or every open transfer. */
export async function listStaffTransferQueue(filter: StaffQueueFilter = "open", now = new Date()) {
  const transfers = await getPrisma().memberTransfer.findMany({
    where: staffQueueWhere(filter, now),
    select: staffListSelect,
    orderBy: [{ acknowledgeDueAt: "asc" }, { id: "asc" }],
    take: 500,
  });
  return transfers.map((transfer) => serializeStaff(transfer, now));
}

/**
 * For staff overriding an unmatched request: the sending club's active
 * members this club year, by name only. Never a birth date or age.
 */
export async function listStaffTransferCandidates(transferId: string, now = new Date()) {
  const transfer = await getPrisma().memberTransfer.findUnique({ where: { id: transferId }, select: { fromOrganizationId: true } });
  if (!transfer) throw new MemberTransferError("TRANSFER_NOT_FOUND", "That transfer could not be found.");
  const rows = await getPrisma().clubRosterMember.findMany({
    where: { organizationId: transfer.fromOrganizationId, clubYear: clubYearFor(now), status: "ACTIVE", personId: { not: null } },
    select: { id: true, attendeeType: true, person: { select: { firstName: true, lastName: true } } },
  });
  return rows
    .map((row) => ({ rosterMemberId: row.id, firstName: row.person!.firstName, lastName: row.person!.lastName, attendeeType: row.attendeeType }))
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
}

// ---------------------------------------------------------------------------
// Registration moves (#489 decision 2)
// ---------------------------------------------------------------------------

function cents(value: { toString(): string } | number) {
  return Math.round(Number(value) * 100);
}

/** A registration's stored total and what has been paid on it (succeeded payments less succeeded refunds), as `checkNewTotal` reads them. */
const registrationMoneySelect = {
  id: true,
  status: true,
  totalAmount: true,
  payments: {
    where: { status: "SUCCEEDED" as const },
    select: { amount: true, refunds: { where: { status: "SUCCEEDED" as const }, select: { amount: true } } },
  },
} satisfies Prisma.RegistrationSelect;

function paidCentsOf(registration: { payments: Array<{ amount: { toString(): string }; refunds: Array<{ amount: { toString(): string } }> }> }) {
  return registration.payments.reduce((total, payment) => (
    total + cents(payment.amount) - payment.refunds.reduce((sum, refund) => sum + cents(refund.amount), 0)
  ), 0);
}

const destinationSelect = {
  ...registrationMoneySelect,
  confirmationCode: true,
  waitlistEntry: { select: { status: true } },
} satisfies Prisma.RegistrationSelect;

const moveSelect = {
  id: true,
  status: true,
  note: true,
  decidedAt: true,
  createdAt: true,
  eventId: true,
  registrationAttendeeId: true,
  fromRegistrationId: true,
  toRegistrationId: true,
  decidedBy: { select: { displayName: true } },
  event: { select: { name: true, startsAt: true } },
  transfer: {
    select: {
      id: true,
      fromOrganizationId: true,
      toOrganizationId: true,
      toRosterMemberId: true,
      toRosterMember: { select: { status: true, personId: true } },
      fromOrganization: { select: { name: true } },
      toOrganization: { select: { name: true } },
    },
  },
  attendee: {
    select: {
      id: true,
      personId: true,
      registrationId: true,
      profileSnapshot: true,
      person: { select: { firstName: true, lastName: true } },
      adjustments: { select: { amountCents: true } },
      honorEnrollments: { select: { offeringId: true, consumesSeat: true, offering: { select: { perClubLimit: true } } } },
    },
  },
  fromRegistration: { select: { ...registrationMoneySelect, confirmationCode: true } },
} satisfies Prisma.MemberTransferRegistrationMoveSelect;

type StoredMove = Prisma.MemberTransferRegistrationMoveGetPayload<{ select: typeof moveSelect }>;

async function moveDestination(client: Client, eventId: string, toOrganizationId: string) {
  const club = await client.clubEventRegistration.findUnique({
    where: { eventId_organizationId: { eventId, organizationId: toOrganizationId } },
    select: { registration: { select: destinationSelect } },
  });
  return club?.registration ?? null;
}

/**
 * Whether moving these class seats to the receiving club would put it over
 * a class's per-club limit, counted the way class selection counts it
 * (`seatHoldingEnrollment`, enforced in `setClassSelections`).
 */
async function exceedsClubClassLimit(
  client: Client,
  eventId: string,
  toOrganizationId: string,
  enrollments: Array<{ offeringId: string; consumesSeat: boolean; offering: { perClubLimit: number | null } }>,
) {
  for (const enrollment of enrollments) {
    const limit = enrollment.offering.perClubLimit;
    if (!enrollment.consumesSeat || limit === null) continue;
    const taken = await client.honorEnrollment.count({
      where: { eventId, offeringId: enrollment.offeringId, organizationId: toOrganizationId, ...seatHoldingEnrollment },
    });
    if (taken + 1 > limit) return true;
  }
  return false;
}

async function describeMove(client: Client, move: StoredMove) {
  const destination = move.status === "APPROVED" && move.toRegistrationId
    ? await client.registration.findUnique({
      where: { id: move.toRegistrationId },
      select: destinationSelect,
    })
    : await moveDestination(client, move.eventId, move.transfer.toOrganizationId);
  const personAlreadyThere = Boolean(destination && move.attendee && move.status === "PENDING" && await client.registrationAttendee.findUnique({
    where: { registrationId_personId: { registrationId: destination.id, personId: move.attendee.personId } },
    select: { id: true },
  }));
  const adjustmentCents = move.attendee?.adjustments.reduce((total, line) => total + line.amountCents, 0) ?? 0;
  const fromPaidCents = move.fromRegistration ? paidCentsOf(move.fromRegistration) : 0;
  const toPaidCents = destination ? paidCentsOf(destination) : 0;
  // A stale move (#489): the member has since left the receiving club, or moved on again.
  const receiving = move.transfer.toRosterMember;
  const receivingMemberActive = Boolean(receiving && receiving.status === "ACTIVE" && move.attendee && receiving.personId === move.attendee.personId);
  const classLimitExceeded = move.status === "PENDING" && move.attendee
    ? await exceedsClubClassLimit(client, move.eventId, move.transfer.toOrganizationId, move.attendee.honorEnrollments)
    : false;
  const blocker = move.status === "PENDING"
    ? registrationMoveBlocker({
      attendeeOnSource: Boolean(move.attendee && move.attendee.registrationId === move.fromRegistrationId),
      sourceStatus: move.fromRegistration?.status ?? null,
      receivingMemberActive,
      destination: destination
        ? { status: destination.status, waitlisted: destination.waitlistEntry?.status === "WAITING", personAlreadyThere }
        : null,
      classLimitExceeded,
      money: move.fromRegistration && destination
        ? {
          fromTotalCents: cents(move.fromRegistration.totalAmount),
          fromPaidCents,
          toTotalCents: cents(destination.totalAmount),
          toPaidCents,
          shiftCents: adjustmentCents,
        }
        : null,
    })
    : null;
  return {
    id: move.id,
    status: move.status,
    transferId: move.transfer.id,
    eventId: move.eventId,
    eventName: move.event.name,
    eventStartsAt: move.event.startsAt.toISOString(),
    memberName: move.attendee?.person ? `${move.attendee.person.firstName} ${move.attendee.person.lastName}` : "Removed attendee",
    fromClubName: move.transfer.fromOrganization.name,
    toClubName: move.transfer.toOrganization.name,
    fromRegistration: move.fromRegistration
      ? {
        id: move.fromRegistration.id,
        confirmationCode: move.fromRegistration.confirmationCode,
        status: move.fromRegistration.status,
        totalCents: cents(move.fromRegistration.totalAmount),
        paidCents: fromPaidCents,
      }
      : null,
    toRegistration: destination
      ? {
        id: destination.id,
        confirmationCode: destination.confirmationCode,
        status: destination.status,
        waitlisted: destination.waitlistEntry?.status === "WAITING",
        totalCents: cents(destination.totalAmount),
        paidCents: toPaidCents,
      }
      : null,
    /** This person's own adjustment lines (scholarships, corrections): they move with them. */
    adjustmentCents,
    blocker,
    note: move.note,
    decidedAt: move.decidedAt?.toISOString() ?? null,
    decidedByName: move.decidedBy?.displayName ?? null,
    createdAt: move.createdAt.toISOString(),
  };
}

export type RegistrationMoveRecord = Awaited<ReturnType<typeof describeMove>>;

/** The staff approval list (#489 decision 2): pending moves first by default, with both registrations' totals. */
export async function listRegistrationMoves(status: "PENDING" | "DECIDED" = "PENDING") {
  const client = getPrisma();
  const moves = await getPrisma().memberTransferRegistrationMove.findMany({
    where: status === "PENDING" ? { status: "PENDING" } : { status: { in: ["APPROVED", "SKIPPED"] } },
    select: moveSelect,
    orderBy: [{ createdAt: status === "PENDING" ? "asc" : "desc" }, { id: "asc" }],
    take: 200,
  });
  const described: RegistrationMoveRecord[] = [];
  for (const move of moves) described.push(await describeMove(client, move));
  return described;
}

/**
 * Staff approve one registration move (#489 decision 2). The attendee and
 * every row keyed to them go to the receiving club's registration together,
 * in one serializable transaction: `RegistrationAdjustment` lines,
 * `HonorEnrollment` rows (and their `organizationId`), and
 * `RegistrationCapacityReservation` rows, and the attendee snapshot's
 * roster link is re-pointed. Operation history stays with the old
 * registration. Check-ins, attendee tags, classifications and attendee-level
 * staff notes are keyed only to the attendee and follow it as is.
 *
 * Nothing is repriced: the priced part of each registration is untouched.
 * The one amount that follows the attendee is their own adjustment lines,
 * and each registration's stored total shifts by exactly those lines so it
 * stays "priced total plus every line", within the same guards a staff
 * adjustment keeps (never below $0, never below what was paid, never from a
 * total that may be clamped at $0). The old registration still carries the
 * person's base price and the new one doesn't, until staff adjust.
 * Payments stay where they were paid.
 *
 * The registration amendment engine isn't used for the move itself: it
 * works inside one registration and reprices it, which this must never do.
 */
export async function approveRegistrationMove(moveId: string, note: string, actor: StaffTransferActor, now = new Date()) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await getPrisma().$transaction(
        (tx) => approveRegistrationMoveOnce(tx, moveId, note, actor, now),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isRetryableTransaction(error)) throw error;
      lastError = error;
    }
  }
  // Still colliding on a unique index after every retry: the one a move can
  // hit is one person per registration, so say that rather than "try again".
  if (isUniqueViolation(lastError)) {
    throw new MemberTransferError("MOVE_BLOCKED", "This person is already on that registration.", "ALREADY_ON_DESTINATION");
  }
  throw new MemberTransferError("TRANSFER_CONFLICT", "Another change touched these registrations at the same time. Refresh and try again.");
}

async function approveRegistrationMoveOnce(tx: Prisma.TransactionClient, moveId: string, note: string, actor: StaffTransferActor, now: Date) {
  const guard = await tx.memberTransferRegistrationMove.updateMany({
    where: { id: moveId, status: "PENDING" },
    data: { status: "APPROVED", decidedAt: now, decidedByUserId: actor.userId, note },
  });
  if (guard.count !== 1) {
    const exists = await tx.memberTransferRegistrationMove.findUnique({ where: { id: moveId }, select: { id: true } });
    throw exists
      ? new MemberTransferError("MOVE_ALREADY_DECIDED", "This registration move was already decided.")
      : new MemberTransferError("MOVE_NOT_FOUND", "That registration move could not be found.");
  }
  const move = await tx.memberTransferRegistrationMove.findUniqueOrThrow({ where: { id: moveId }, select: moveSelect });
  // Described as still pending, so the same blocker rules the list shows apply here.
  const described = await describeMove(tx, { ...move, status: "PENDING" });
  if (described.blocker || !move.attendee || !described.toRegistration || !move.fromRegistration) {
    const blocker = described.blocker ?? "ATTENDEE_GONE";
    throw new MemberTransferError("MOVE_BLOCKED", registrationMoveBlockerLabels[blocker], blocker);
  }
  const attendeeId = move.attendee.id;
  const fromRegistrationId = move.fromRegistration.id;
  const toRegistrationId = described.toRegistration.id;

  const last = await tx.registrationAttendee.findFirst({
    where: { registrationId: toRegistrationId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  // The attendee's snapshot names their roster row; point it at the
  // receiving club's row, so that club's registration shows them on its
  // roster (not "off roster", where a director could untick them).
  const snapshot = move.attendee.profileSnapshot && typeof move.attendee.profileSnapshot === "object" && !Array.isArray(move.attendee.profileSnapshot)
    ? move.attendee.profileSnapshot as Prisma.JsonObject
    : {};
  await tx.registrationAttendee.update({
    where: { id: attendeeId },
    data: {
      registrationId: toRegistrationId,
      position: (last?.position ?? -1) + 1,
      profileSnapshot: { ...snapshot, clubRosterMemberId: move.transfer.toRosterMemberId },
    },
  });
  const adjustments = await tx.registrationAdjustment.updateMany({
    where: { registrationAttendeeId: attendeeId, registrationId: fromRegistrationId },
    data: { registrationId: toRegistrationId },
  });
  const honorEnrollments = await tx.honorEnrollment.updateMany({
    where: { registrationAttendeeId: attendeeId },
    data: { registrationId: toRegistrationId, organizationId: move.transfer.toOrganizationId },
  });
  const reservations = await tx.registrationCapacityReservation.updateMany({
    where: { registrationAttendeeId: attendeeId },
    data: { registrationId: toRegistrationId },
  });
  // `RegistrationOperation` rows stay put: they are the old registration's
  // history (substitution snapshots), and their key to the attendee still holds.

  const shiftCents = described.adjustmentCents;
  const fromTotalBefore = described.fromRegistration!.totalCents;
  const toTotalBefore = described.toRegistration.totalCents;
  const fromTotalAfter = fromTotalBefore - shiftCents;
  const toTotalAfter = toTotalBefore + shiftCents;
  // `updatedAt` moves on both, so an amendment review opened before this move is refused as stale.
  await tx.registration.update({ where: { id: fromRegistrationId }, data: { totalAmount: fromTotalAfter / 100, updatedAt: now } });
  await tx.registration.update({ where: { id: toRegistrationId }, data: { totalAmount: toTotalAfter / 100, updatedAt: now } });

  await tx.memberTransferRegistrationMove.update({ where: { id: moveId }, data: { toRegistrationId } });
  const detail = {
    moveId,
    fromRegistrationId,
    toRegistrationId,
    adjustmentLinesMoved: adjustments.count,
    adjustmentCentsMoved: shiftCents,
    honorEnrollmentsMoved: honorEnrollments.count,
    capacityReservationsMoved: reservations.count,
    fromTotalCentsBefore: fromTotalBefore,
    fromTotalCentsAfter: fromTotalAfter,
    toTotalCentsBefore: toTotalBefore,
    toTotalCentsAfter: toTotalAfter,
  };
  await transferEvent(tx, move.transfer.id, "REGISTRATION_MOVE_APPROVED", actor, note, { eventId: move.eventId, ...detail });
  await audit(
    tx,
    actor,
    "CLUB_MEMBER_TRANSFER_REGISTRATION_MOVE_APPROVED",
    attendeeId,
    "Conference staff moved a transferred member's event registration to the receiving club. Nothing was repriced.",
    { transferId: move.transfer.id, fromOrganizationId: move.transfer.fromOrganizationId, toOrganizationId: move.transfer.toOrganizationId, ...detail },
    { eventId: move.eventId, entityType: "RegistrationAttendee" },
  );
  return detail;
}

/** Staff skip one registration move (#489 decision 2): the attendee stays where they are. Audited with the actor (N4). */
export async function skipRegistrationMove(moveId: string, note: string, actor: StaffTransferActor, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const guard = await tx.memberTransferRegistrationMove.updateMany({
      where: { id: moveId, status: "PENDING" },
      data: { status: "SKIPPED", decidedAt: now, decidedByUserId: actor.userId, note },
    });
    if (guard.count !== 1) {
      const exists = await tx.memberTransferRegistrationMove.findUnique({ where: { id: moveId }, select: { id: true } });
      throw exists
        ? new MemberTransferError("MOVE_ALREADY_DECIDED", "This registration move was already decided.")
        : new MemberTransferError("MOVE_NOT_FOUND", "That registration move could not be found.");
    }
    const move = await tx.memberTransferRegistrationMove.findUniqueOrThrow({
      where: { id: moveId },
      select: { eventId: true, transferId: true, registrationAttendeeId: true, fromRegistrationId: true },
    });
    await transferEvent(tx, move.transferId, "REGISTRATION_MOVE_SKIPPED", actor, note, { eventId: move.eventId, moveId });
    await audit(
      tx,
      actor,
      "CLUB_MEMBER_TRANSFER_REGISTRATION_MOVE_SKIPPED",
      move.registrationAttendeeId ?? moveId,
      "Conference staff skipped moving a transferred member's event registration; it stays with the old club.",
      { transferId: move.transferId, moveId, fromRegistrationId: move.fromRegistrationId },
      { eventId: move.eventId, entityType: "RegistrationAttendee" },
    );
    return { moveId };
  });
}
