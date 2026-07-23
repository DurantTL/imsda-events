import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  enqueueAttendeeSubstitutedMessage,
  enqueueRegistrationTransferredNewContactMessage,
  enqueueRegistrationTransferredPriorContactMessage,
  type QueuedTransactionalMessage,
} from "@/modules/communications/transactional-messages";
import {
  identitiesDescribeSamePerson,
  registrationOperationFingerprint,
} from "@/modules/registrations/operations-domain";
import { getRegistrationByIdWithClient } from "@/modules/registrations/repository";
import type {
  AttendeeSubstitutionInput,
  RegistrationTransferInput,
} from "@/modules/registrations/schemas";

type RegistrationOperationKind = "TRANSFER" | "ATTENDEE_SUBSTITUTION";

export type RegistrationOperationErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "ATTENDEE_NOT_FOUND"
  | "ATTENDEE_CHECKED_IN"
  | "ATTENDEE_ALREADY_IN_PARTY"
  | "ATTENDEE_SAME_PERSON"
  | "TRANSFER_SAME_DESTINATION"
  | "IDEMPOTENCY_KEY_REUSED"
  | "OPERATION_CONFLICT";

export class RegistrationOperationError extends Error {
  constructor(
    public readonly code: RegistrationOperationErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RegistrationOperationError";
  }
}

type OperationActor = {
  id: string;
  displayName: string;
};

type NoticeRecipient = {
  role: "NEW_CONTACT" | "PRIOR_CONTACT" | "REGISTRATION_CONTACT"
    | "PRIOR_ATTENDEE" | "REPLACEMENT_ATTENDEE";
  email: string;
};

export type RegistrationOperationResponse = {
  registration: NonNullable<Awaited<ReturnType<typeof getRegistrationByIdWithClient>>>;
  operation: {
    id: string;
    type: RegistrationOperationKind;
    createdAt: string;
    noticeMessageIds: string[];
    noticeRecipients: NoticeRecipient[];
    deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  };
};

export type RegistrationOperationResult = {
  response: RegistrationOperationResponse;
  pendingMessageIds: string[];
};

const operationRegistrationInclude = {
  accountHolderPerson: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      normalizedEmail: true,
      phone: true,
    },
  },
  attendees: {
    orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }],
    include: {
      person: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          normalizedEmail: true,
          phone: true,
        },
      },
      checkIns: {
        where: { undoneAt: null },
        select: { id: true, checkedInAt: true },
      },
    },
  },
  publicFormSubmission: {
    select: {
      id: true,
      formVersionId: true,
      idempotencyKey: true,
      requestHash: true,
      responses: true,
      attendeeResponses: true,
      pricingSnapshot: true,
      createdAt: true,
    },
  },
  payments: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      amount: true,
      status: true,
      method: true,
      externalReference: true,
      receivedAt: true,
      refunds: {
        orderBy: { createdAt: "asc" as const },
        select: {
          id: true,
          amount: true,
          status: true,
          externalReference: true,
          reason: true,
          createdAt: true,
        },
      },
    },
  },
  capacityReservations: {
    orderBy: { id: "asc" as const },
    select: {
      id: true,
      registrationAttendeeId: true,
      participantKey: true,
      fieldId: true,
      fieldKey: true,
      optionValue: true,
      rank: true,
      releasedAt: true,
      createdAt: true,
    },
  },
  waitlistEntry: {
    select: {
      id: true,
      position: true,
      attendeeCount: true,
      status: true,
      joinedAt: true,
      promotedAt: true,
      removedAt: true,
    },
  },
  promoCodeRedemption: {
    select: {
      id: true,
      promoCodeId: true,
      codeSnapshot: true,
      discountTypeSnapshot: true,
      discountValueSnapshot: true,
      eligibleSubtotalCents: true,
      discountAmountCents: true,
      pricingDate: true,
      createdAt: true,
    },
  },
} satisfies Prisma.RegistrationInclude;

type OperationRegistration = Prisma.RegistrationGetPayload<{
  include: typeof operationRegistrationInclude;
}>;

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function snapshotString(
  value: unknown,
  key: "firstName" | "lastName" | "email" | "phone",
  fallback = "",
) {
  const record = jsonRecord(value);
  return typeof record[key] === "string" ? record[key].trim() : fallback;
}

function validNoticeEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function contactIdentity(registration: OperationRegistration) {
  return {
    personId: registration.accountHolderPersonId,
    firstName: snapshotString(
      registration.contactSnapshot,
      "firstName",
      registration.accountHolderPerson.firstName,
    ),
    lastName: snapshotString(
      registration.contactSnapshot,
      "lastName",
      registration.accountHolderPerson.lastName,
    ),
    email: snapshotString(
      registration.contactSnapshot,
      "email",
      registration.accountHolderPerson.normalizedEmail ?? "",
    ).toLowerCase(),
    phone: snapshotString(
      registration.contactSnapshot,
      "phone",
      registration.accountHolderPerson.phone ?? "",
    ),
  };
}

function attendeeIdentity(
  attendee: OperationRegistration["attendees"][number],
) {
  return {
    personId: attendee.personId,
    firstName: snapshotString(
      attendee.profileSnapshot,
      "firstName",
      attendee.person.firstName,
    ),
    lastName: snapshotString(
      attendee.profileSnapshot,
      "lastName",
      attendee.person.lastName,
    ),
    email: snapshotString(
      attendee.profileSnapshot,
      "email",
      attendee.person.normalizedEmail ?? "",
    ).toLowerCase(),
    phone: snapshotString(
      attendee.profileSnapshot,
      "phone",
      attendee.person.phone ?? "",
    ),
  };
}

function iso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function operationalSnapshot(
  registration: OperationRegistration,
  activeManageTokenCount: number,
) {
  return {
    registration: {
      id: registration.id,
      eventId: registration.eventId,
      confirmationCode: registration.confirmationCode,
      status: registration.status,
      totalAmount: registration.totalAmount.toString(),
      submittedAt: iso(registration.submittedAt),
      cancelledAt: iso(registration.cancelledAt),
      createdAt: registration.createdAt.toISOString(),
      accountHolder: contactIdentity(registration),
      contactSnapshot: registration.contactSnapshot,
    },
    attendees: registration.attendees.map((attendee) => ({
      id: attendee.id,
      personId: attendee.personId,
      identity: attendeeIdentity(attendee),
      attendeeType: attendee.attendeeType,
      position: attendee.position,
      profileSnapshot: attendee.profileSnapshot,
      formResponses: attendee.formResponses,
      activeCheckInIds: attendee.checkIns.map((checkIn) => checkIn.id),
    })),
    publicFormSubmission: registration.publicFormSubmission
      ? {
          ...registration.publicFormSubmission,
          createdAt: registration.publicFormSubmission.createdAt.toISOString(),
        }
      : null,
    payments: registration.payments.map((payment) => ({
      ...payment,
      amount: payment.amount.toString(),
      receivedAt: iso(payment.receivedAt),
      refunds: payment.refunds.map((refund) => ({
        ...refund,
        amount: refund.amount.toString(),
        createdAt: refund.createdAt.toISOString(),
      })),
    })),
    capacityReservations: registration.capacityReservations.map((reservation) => ({
      ...reservation,
      releasedAt: iso(reservation.releasedAt),
      createdAt: reservation.createdAt.toISOString(),
    })),
    waitlistEntry: registration.waitlistEntry
      ? {
          ...registration.waitlistEntry,
          joinedAt: registration.waitlistEntry.joinedAt.toISOString(),
          promotedAt: iso(registration.waitlistEntry.promotedAt),
          removedAt: iso(registration.waitlistEntry.removedAt),
        }
      : null,
    promoCodeRedemption: registration.promoCodeRedemption
      ? {
          ...registration.promoCodeRedemption,
          createdAt: registration.promoCodeRedemption.createdAt.toISOString(),
        }
      : null,
    activeManageTokenCount,
  };
}

function operationReplay(
  existing: {
    registrationId: string;
    attendeeId: string | null;
    type: RegistrationOperationKind;
    requestFingerprint: string;
    responseSnapshot: Prisma.JsonValue;
  },
  expected: {
    registrationId: string;
    attendeeId?: string;
    type: RegistrationOperationKind;
    requestFingerprint: string;
  },
) {
  if (
    existing.registrationId !== expected.registrationId
    || existing.attendeeId !== (expected.attendeeId ?? null)
    || existing.type !== expected.type
    || existing.requestFingerprint !== expected.requestFingerprint
  ) {
    throw new RegistrationOperationError(
      "IDEMPOTENCY_KEY_REUSED",
      "That request ID was already used with different transfer or substitution details. Start a new review to create a new request ID.",
    );
  }
  const response = existing.responseSnapshot as unknown as RegistrationOperationResponse;
  return {
    response,
    pendingMessageIds: response.operation.noticeMessageIds,
  };
}

function combineQueuedNotices(
  queued: QueuedTransactionalMessage[],
  recipients: NoticeRecipient[],
) {
  const firstMode = queued[0]?.deliveryMode ?? "LOCAL_CAPTURE";
  return {
    messageIds: [...new Set(queued.flatMap((entry) => entry.messageIds))],
    pendingMessageIds: [...new Set(
      queued.flatMap((entry) => entry.pendingMessageIds),
    )],
    deliveryMode: firstMode,
    recipients,
  };
}

async function loadOperationRegistration(
  tx: Prisma.TransactionClient,
  eventId: string,
  registrationId: string,
) {
  return tx.registration.findFirst({
    where: { id: registrationId, eventId },
    include: operationRegistrationInclude,
  });
}

async function activeManageTokenCount(
  tx: Prisma.TransactionClient,
  registrationId: string,
  now: Date,
) {
  return tx.registrationAccessToken.count({
    where: {
      registrationId,
      purpose: "MANAGE_REGISTRATION",
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
}

function retryableOperationTransactionError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2002" || error.code === "P2034");
}

async function runSerializableOperation(
  operation: (tx: Prisma.TransactionClient) => Promise<RegistrationOperationResult>,
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!retryableOperationTransactionError(error)) throw error;
    }
  }
  throw new RegistrationOperationError(
    "OPERATION_CONFLICT",
    "Another staff action changed this registration at the same time. Refresh the registration, review the change again, and retry.",
  );
}

export async function transferRegistration(
  eventId: string,
  registrationId: string,
  input: RegistrationTransferInput,
  actor: OperationActor,
  now = new Date(),
) {
  const requestFingerprint = registrationOperationFingerprint({
    eventId,
    registrationId,
    operation: "TRANSFER",
    payload: {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      reason: input.reason,
    },
  });

  return runSerializableOperation(async (tx) => {
    const existingOperation = await tx.registrationOperation.findUnique({
      where: {
        eventId_clientRequestId: {
          eventId,
          clientRequestId: input.clientRequestId,
        },
      },
      select: {
        registrationId: true,
        attendeeId: true,
        type: true,
        requestFingerprint: true,
        responseSnapshot: true,
      },
    });
    if (existingOperation) {
      return operationReplay(existingOperation, {
        registrationId,
        type: "TRANSFER",
        requestFingerprint,
      });
    }

    const registration = await loadOperationRegistration(
      tx,
      eventId,
      registrationId,
    );
    if (!registration) {
      throw new RegistrationOperationError(
        "REGISTRATION_NOT_FOUND",
        "The registration could not be found for this event.",
      );
    }

    const prior = contactIdentity(registration);
    const nextIdentity = {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
    };
    const destinationPerson = await tx.person.findUnique({
      where: { normalizedEmail: input.email },
      select: { id: true },
    });
    if (
      destinationPerson?.id === registration.accountHolderPersonId
      || identitiesDescribeSamePerson(prior, nextIdentity)
    ) {
      throw new RegistrationOperationError(
        "TRANSFER_SAME_DESTINATION",
        "The new contact matches the current registration destination. Use Edit contact for a correction, or enter a different person for a transfer.",
      );
    }

    const activeTokenCountBefore = await activeManageTokenCount(
      tx,
      registrationId,
      now,
    );
    const beforeSnapshot = operationalSnapshot(
      registration,
      activeTokenCountBefore,
    );
    const newPerson = destinationPerson ?? await tx.person.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        normalizedEmail: input.email,
        phone: input.phone || null,
      },
      select: { id: true },
    });

    await tx.registration.update({
      where: { id: registrationId },
      data: {
        accountHolderPersonId: newPerson.id,
        contactSnapshot: {
          ...jsonRecord(registration.contactSnapshot),
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
        },
      },
    });
    const revoked = await tx.registrationAccessToken.updateMany({
      where: {
        registrationId,
        purpose: "MANAGE_REGISTRATION",
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });

    const operationId = randomUUID();
    const correlationId = input.clientRequestId;
    const recipientName = `${input.firstName} ${input.lastName}`.trim();
    const priorName = `${prior.firstName} ${prior.lastName}`.trim();
    const queued: QueuedTransactionalMessage[] = [];
    const recipients: NoticeRecipient[] = [];
    const newNotice = await enqueueRegistrationTransferredNewContactMessage(tx, {
      eventId,
      registrationId,
      correlationId,
      transitionKey: `registration-transfer:${operationId}:new`,
      recipientEmail: input.email,
      recipientName,
      priorPersonName: priorName,
      newPersonName: recipientName,
      metadata: {
        operationId,
        recipientRole: "NEW_CONTACT",
        accessIssuedAfterCommit: true,
      },
    });
    queued.push(newNotice);
    if (newNotice.skippedReason === null) {
      recipients.push({ role: "NEW_CONTACT", email: input.email });
    }
    if (
      validNoticeEmail(prior.email)
      && prior.email.toLowerCase() !== input.email.toLowerCase()
    ) {
      const priorNotice = await enqueueRegistrationTransferredPriorContactMessage(
        tx,
        {
          eventId,
          registrationId,
          correlationId,
          transitionKey: `registration-transfer:${operationId}:prior`,
          recipientEmail: prior.email,
          recipientName: priorName,
          priorPersonName: priorName,
          newPersonName: recipientName,
          metadata: {
            operationId,
            recipientRole: "PRIOR_CONTACT",
            priorAccessRevoked: true,
          },
        },
      );
      queued.push(priorNotice);
      if (priorNotice.skippedReason === null) {
        recipients.push({ role: "PRIOR_CONTACT", email: prior.email });
      }
    }
    const notices = combineQueuedNotices(queued, recipients);

    const afterRegistration = await loadOperationRegistration(
      tx,
      eventId,
      registrationId,
    );
    const registrationRecord = await getRegistrationByIdWithClient(
      tx,
      eventId,
      registrationId,
    );
    if (!afterRegistration || !registrationRecord) {
      throw new RegistrationOperationError(
        "OPERATION_CONFLICT",
        "The transferred registration could not be reloaded safely.",
      );
    }
    const afterSnapshot = operationalSnapshot(afterRegistration, 0);
    const createdAt = now.toISOString();
    const response: RegistrationOperationResponse = {
      registration: registrationRecord,
      operation: {
        id: operationId,
        type: "TRANSFER",
        createdAt,
        noticeMessageIds: notices.messageIds,
        noticeRecipients: notices.recipients,
        deliveryMode: notices.deliveryMode,
      },
    };

    await tx.registrationOperation.create({
      data: {
        id: operationId,
        eventId,
        registrationId,
        type: "TRANSFER",
        clientRequestId: input.clientRequestId,
        requestFingerprint,
        actorUserId: actor.id,
        actorNameSnapshot: actor.displayName,
        beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
        afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
        responseSnapshot: response as unknown as Prisma.InputJsonValue,
        createdAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId: actor.id,
        action: "REGISTRATION_TRANSFERRED",
        entityType: "RegistrationOperation",
        entityId: operationId,
        correlationId,
        summary: `Transferred registration ${registration.confirmationCode} from ${priorName} to ${recipientName}.`,
        metadata: {
          operationId,
          clientRequestId: input.clientRequestId,
          reason: input.reason,
          before: prior,
          after: { ...nextIdentity, personId: newPerson.id },
          revokedActiveManageTokenCount: revoked.count,
          newPrivateAccessIssuedAfterCommit: true,
          noticeMessageIds: notices.messageIds,
          noticeRecipients: notices.recipients,
          preserved: [
            "registration id and confirmation code",
            "status and waitlist position",
            "attendee party and submitted form choices",
            "immutable form and order snapshot",
            "total, payments, and refunds",
            "promo redemption",
            "capacity reservations",
          ],
        },
      },
    });
    return { response, pendingMessageIds: notices.pendingMessageIds };
  });
}

export async function substituteRegistrationAttendee(
  eventId: string,
  registrationId: string,
  attendeeId: string,
  input: AttendeeSubstitutionInput,
  actor: OperationActor,
  now = new Date(),
) {
  const requestFingerprint = registrationOperationFingerprint({
    eventId,
    registrationId,
    attendeeId,
    operation: "ATTENDEE_SUBSTITUTION",
    payload: {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      reason: input.reason,
    },
  });

  return runSerializableOperation(async (tx) => {
    const existingOperation = await tx.registrationOperation.findUnique({
      where: {
        eventId_clientRequestId: {
          eventId,
          clientRequestId: input.clientRequestId,
        },
      },
      select: {
        registrationId: true,
        attendeeId: true,
        type: true,
        requestFingerprint: true,
        responseSnapshot: true,
      },
    });
    if (existingOperation) {
      return operationReplay(existingOperation, {
        registrationId,
        attendeeId,
        type: "ATTENDEE_SUBSTITUTION",
        requestFingerprint,
      });
    }

    const registration = await loadOperationRegistration(
      tx,
      eventId,
      registrationId,
    );
    if (!registration) {
      throw new RegistrationOperationError(
        "REGISTRATION_NOT_FOUND",
        "The registration could not be found for this event.",
      );
    }
    const attendee = registration.attendees.find(
      (candidate) => candidate.id === attendeeId,
    );
    if (!attendee) {
      throw new RegistrationOperationError(
        "ATTENDEE_NOT_FOUND",
        "The attendee could not be found in this registration.",
      );
    }
    if (attendee.checkIns.length > 0) {
      throw new RegistrationOperationError(
        "ATTENDEE_CHECKED_IN",
        "A checked-in attendee cannot be substituted. Undo the check-in first if the check-in was recorded by mistake.",
        { checkedInAt: attendee.checkIns[0]?.checkedInAt.toISOString() ?? null },
      );
    }

    const prior = attendeeIdentity(attendee);
    const replacement = {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
    };
    const replacementPerson = input.email
      ? await tx.person.findUnique({
          where: { normalizedEmail: input.email },
          select: { id: true },
        })
      : null;
    if (
      replacementPerson?.id === attendee.personId
      || identitiesDescribeSamePerson(prior, replacement)
    ) {
      throw new RegistrationOperationError(
        "ATTENDEE_SAME_PERSON",
        "The replacement matches the current attendee. Use a new person for an attendee substitution.",
      );
    }

    for (const partyMember of registration.attendees) {
      if (partyMember.id === attendeeId) continue;
      const partyIdentity = attendeeIdentity(partyMember);
      if (
        replacementPerson?.id === partyMember.personId
        || identitiesDescribeSamePerson(partyIdentity, replacement)
      ) {
        throw new RegistrationOperationError(
          "ATTENDEE_ALREADY_IN_PARTY",
          `${partyIdentity.firstName} ${partyIdentity.lastName} is already in this registration. Choose a person who is not already in the attendee party.`,
          { existingAttendeeId: partyMember.id },
        );
      }
    }

    const activeTokenCount = await activeManageTokenCount(
      tx,
      registrationId,
      now,
    );
    const beforeSnapshot = operationalSnapshot(
      registration,
      activeTokenCount,
    );
    const newPerson = replacementPerson ?? await tx.person.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        normalizedEmail: input.email || null,
        phone: input.phone || null,
      },
      select: { id: true },
    });
    const operationId = randomUUID();
    await tx.registrationAttendee.update({
      where: { id: attendeeId },
      data: {
        personId: newPerson.id,
        profileSnapshot: {
          ...jsonRecord(attendee.profileSnapshot),
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email || null,
          phone: input.phone || null,
          identityUpdatedBy: "STAFF_ATTENDEE_SUBSTITUTION",
          identityOperationId: operationId,
        },
      },
    });

    const priorName = `${prior.firstName} ${prior.lastName}`.trim();
    const replacementName = `${input.firstName} ${input.lastName}`.trim();
    const registrationContact = contactIdentity(registration);
    const recipientCandidates: NoticeRecipient[] = [
      {
        role: "REGISTRATION_CONTACT",
        email: registrationContact.email,
      },
      { role: "PRIOR_ATTENDEE", email: prior.email },
      { role: "REPLACEMENT_ATTENDEE", email: input.email },
    ];
    const uniqueRecipients = new Map<string, NoticeRecipient[]>();
    for (const recipient of recipientCandidates) {
      const email = recipient.email.trim().toLowerCase();
      if (!validNoticeEmail(email)) continue;
      const roles = uniqueRecipients.get(email) ?? [];
      roles.push({ ...recipient, email });
      uniqueRecipients.set(email, roles);
    }
    const queued: QueuedTransactionalMessage[] = [];
    const recipients: NoticeRecipient[] = [];
    for (const [email, roles] of uniqueRecipients) {
      const roleNames = roles.map((recipient) => recipient.role);
      const recipientName = roleNames.includes("REPLACEMENT_ATTENDEE")
        ? replacementName
        : roleNames.includes("PRIOR_ATTENDEE")
          ? priorName
          : `${registrationContact.firstName} ${registrationContact.lastName}`.trim();
      const notice = await enqueueAttendeeSubstitutedMessage(tx, {
        eventId,
        registrationId,
        correlationId: input.clientRequestId,
        transitionKey: `attendee-substitution:${operationId}:${email}`,
        recipientEmail: email,
        recipientName,
        priorPersonName: priorName,
        newPersonName: replacementName,
        metadata: {
          operationId,
          attendeeId,
          recipientRoles: roleNames.join(","),
        },
      });
      queued.push(notice);
      if (notice.skippedReason === null) recipients.push(...roles);
    }
    const notices = combineQueuedNotices(queued, recipients);

    const afterRegistration = await loadOperationRegistration(
      tx,
      eventId,
      registrationId,
    );
    const registrationRecord = await getRegistrationByIdWithClient(
      tx,
      eventId,
      registrationId,
    );
    if (!afterRegistration || !registrationRecord) {
      throw new RegistrationOperationError(
        "OPERATION_CONFLICT",
        "The substituted attendee could not be reloaded safely.",
      );
    }
    const afterSnapshot = operationalSnapshot(
      afterRegistration,
      activeTokenCount,
    );
    const response: RegistrationOperationResponse = {
      registration: registrationRecord,
      operation: {
        id: operationId,
        type: "ATTENDEE_SUBSTITUTION",
        createdAt: now.toISOString(),
        noticeMessageIds: notices.messageIds,
        noticeRecipients: notices.recipients,
        deliveryMode: notices.deliveryMode,
      },
    };

    await tx.registrationOperation.create({
      data: {
        id: operationId,
        eventId,
        registrationId,
        attendeeId,
        type: "ATTENDEE_SUBSTITUTION",
        clientRequestId: input.clientRequestId,
        requestFingerprint,
        actorUserId: actor.id,
        actorNameSnapshot: actor.displayName,
        beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
        afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
        responseSnapshot: response as unknown as Prisma.InputJsonValue,
        createdAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId: actor.id,
        action: "REGISTRATION_ATTENDEE_SUBSTITUTED",
        entityType: "RegistrationOperation",
        entityId: operationId,
        correlationId: input.clientRequestId,
        summary: `Substituted ${priorName} with ${replacementName} on registration ${registration.confirmationCode}.`,
        metadata: {
          operationId,
          clientRequestId: input.clientRequestId,
          registrationId,
          attendeeId,
          reason: input.reason,
          before: prior,
          after: { ...replacement, personId: newPerson.id },
          noticeMessageIds: notices.messageIds,
          noticeRecipients: notices.recipients,
          preserved: [
            "attendee id and party position",
            "attendee type and submitted form choices",
            "capacity reservations and pricing",
            "registration contact, id, confirmation code, and status",
            "total, payments, and refunds",
            "promo redemption and waitlist position",
          ],
        },
      },
    });
    return { response, pendingMessageIds: notices.pendingMessageIds };
  });
}
