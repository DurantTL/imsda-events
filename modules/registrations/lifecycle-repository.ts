import "server-only";

import { Prisma, type RegistrationStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  enqueueRegistrationCancelledMessage,
  enqueueWaitlistJoinedMessage,
  enqueueWaitlistPromotedMessage,
} from "@/modules/communications/transactional-messages";
import {
  getAvailabilityMode,
  isChoiceFieldType,
  isFieldVisible,
  registrationFormDefinitionSchema,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import {
  activeRegistrationStatuses,
  decideEventCapacity,
  remainingEventCapacity,
} from "@/modules/events/lifecycle";
import { getRegistrationById, type RegistrationRecord } from "@/modules/registrations/repository";

export type RegistrationLifecycleErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "INVALID_REGISTRATION_TRANSITION"
  | "WAITLIST_NOT_ENABLED"
  | "WAITLIST_ENTRY_NOT_FOUND"
  | "EVENT_CAPACITY_UNAVAILABLE"
  | "OPTION_CAPACITY_UNAVAILABLE"
  | "OPTION_CONFIGURATION_INVALID"
  | "REGISTRATION_TRANSITION_CONFLICT";

export class RegistrationLifecycleError extends Error {
  constructor(
    public readonly code: RegistrationLifecycleErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RegistrationLifecycleError";
  }
}

const lifecycleRegistrationInclude = {
  attendees: {
    orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }],
    select: { id: true, position: true, formResponses: true },
  },
  capacityReservations: { orderBy: { createdAt: "asc" as const } },
  publicFormSubmission: {
    select: {
      responses: true,
      formVersion: {
        select: { id: true, formId: true, definition: true },
      },
    },
  },
  waitlistEntry: true,
} satisfies Prisma.RegistrationInclude;

type LifecycleRegistration = Prisma.RegistrationGetPayload<{
  include: typeof lifecycleRegistrationInclude;
}>;

type LifecycleEvent = {
  id: string;
  name: string;
  capacity: number | null;
  waitlistEnabled: boolean;
  autoPromoteWaitlist: boolean;
};

type ReservationClaim = {
  eventId: string;
  formId: string;
  formVersionId: string;
  registrationId: string;
  registrationAttendeeId: string | null;
  participantKey: string;
  fieldId: string;
  fieldKey: string;
  optionValue: string;
  rank: number | null;
  limit: number | null;
};

type CapacityCheck = {
  fits: boolean;
  reason: string | null;
  details: Record<string, unknown>;
};

function recordFromJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isActiveStatus(status: RegistrationStatus) {
  return activeRegistrationStatuses.includes(status as typeof activeRegistrationStatuses[number]);
}

async function loadEvent(tx: Prisma.TransactionClient, eventId: string): Promise<LifecycleEvent> {
  const event = await tx.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      name: true,
      capacity: true,
      waitlistEnabled: true,
      autoPromoteWaitlist: true,
    },
  });
  if (!event) {
    throw new RegistrationLifecycleError(
      "REGISTRATION_NOT_FOUND",
      "The event or registration could not be found.",
    );
  }
  return event;
}

async function loadRegistration(
  tx: Prisma.TransactionClient,
  eventId: string,
  registrationId: string,
) {
  const registration = await tx.registration.findFirst({
    where: { id: registrationId, eventId },
    include: lifecycleRegistrationInclude,
  });
  if (!registration) {
    throw new RegistrationLifecycleError(
      "REGISTRATION_NOT_FOUND",
      "The registration could not be found for this event.",
    );
  }
  return registration;
}

function requireStatus(
  registration: LifecycleRegistration,
  allowed: readonly RegistrationStatus[],
  action: string,
) {
  if (allowed.includes(registration.status)) return;
  throw new RegistrationLifecycleError(
    "INVALID_REGISTRATION_TRANSITION",
    `${action} is not allowed while registration ${registration.confirmationCode} is ${registration.status.toLowerCase()}.`,
    { currentStatus: registration.status, allowedStatuses: allowed },
  );
}

function parsedDefinition(registration: LifecycleRegistration) {
  const submission = registration.publicFormSubmission;
  if (!submission) return null;
  const parsed = registrationFormDefinitionSchema.safeParse(submission.formVersion.definition);
  if (!parsed.success) {
    throw new RegistrationLifecycleError(
      "OPTION_CONFIGURATION_INVALID",
      "The immutable form definition for this registration cannot be used to restore option capacity safely.",
      { formVersionId: submission.formVersion.id },
    );
  }
  return parsed.data;
}

function selectedValues(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" && value ? [value] : [];
}

function claimsFromPublicSubmission(
  registration: LifecycleRegistration,
  definition: RegistrationFormDefinition,
): ReservationClaim[] {
  const submission = registration.publicFormSubmission;
  if (!submission) return [];
  const registrationResponses = recordFromJson(submission.responses);
  const claims: ReservationClaim[] = [];

  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (!isChoiceFieldType(field.type) || getAvailabilityMode(field) === "NONE") continue;
      const participants = field.scope === "REGISTRATION"
        ? [{
            registrationAttendeeId: null,
            participantKey: "registration",
            responses: registrationResponses,
          }]
        : registration.attendees.map((attendee) => ({
            registrationAttendeeId: attendee.id,
            participantKey: attendee.id,
            responses: {
              ...registrationResponses,
              ...recordFromJson(attendee.formResponses),
            },
          }));

      for (const participant of participants) {
        if (!isFieldVisible(field, participant.responses)) continue;
        selectedValues(participant.responses[field.key]).forEach((optionValue, rank) => {
          claims.push({
            eventId: registration.eventId,
            formId: submission.formVersion.formId,
            formVersionId: submission.formVersion.id,
            registrationId: registration.id,
            registrationAttendeeId: participant.registrationAttendeeId,
            participantKey: participant.participantKey,
            fieldId: field.id,
            fieldKey: field.key,
            optionValue,
            rank: field.type === "RANKED_CHOICE" ? rank : null,
            limit: getAvailabilityMode(field) === "CAPACITY"
              ? field.choiceLimits?.[optionValue] ?? null
              : null,
          });
        });
      }
    }
  }
  return claims;
}

function desiredReservationClaims(registration: LifecycleRegistration): ReservationClaim[] {
  const definition = parsedDefinition(registration);
  if (definition) return claimsFromPublicSubmission(registration, definition);
  if (registration.capacityReservations.length === 0) return [];
  throw new RegistrationLifecycleError(
    "OPTION_CONFIGURATION_INVALID",
    "This registration has option reservations without an immutable form definition, so capacity cannot be restored safely.",
    { registrationId: registration.id },
  );
}

async function checkEventCapacity(
  tx: Prisma.TransactionClient,
  event: LifecycleEvent,
  registration: LifecycleRegistration,
): Promise<CapacityCheck> {
  const occupied = await tx.registrationAttendee.count({
    where: {
      eventId: event.id,
      registrationId: { not: registration.id },
      registration: { status: { in: [...activeRegistrationStatuses] } },
    },
  });
  const requested = registration.attendees.length;
  const decision = decideEventCapacity({
    capacity: event.capacity,
    occupied,
    requested,
    waitlistEnabled: false,
  });
  const remaining = remainingEventCapacity(event.capacity, occupied);
  return decision === "REGISTER"
    ? { fits: true, reason: null, details: { occupied, requested, remaining } }
    : {
        fits: false,
        reason: `The event has ${remaining ?? 0} remaining spot${remaining === 1 ? "" : "s"}, but this registration needs ${requested}.`,
        details: { occupied, requested, remaining },
      };
}

async function checkOptionCapacity(
  tx: Prisma.TransactionClient,
  registration: LifecycleRegistration,
  claims: ReservationClaim[],
): Promise<CapacityCheck> {
  const grouped = new Map<string, ReservationClaim[]>();
  for (const claim of claims) {
    if (claim.limit === null) continue;
    const key = `${claim.formId}\u0000${claim.fieldId}\u0000${claim.optionValue}`;
    const group = grouped.get(key) ?? [];
    group.push(claim);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    const claim = group[0];
    const occupied = await tx.registrationCapacityReservation.count({
      where: {
        formId: claim.formId,
        fieldId: claim.fieldId,
        optionValue: claim.optionValue,
        releasedAt: null,
        registrationId: { not: registration.id },
        registration: { status: { in: [...activeRegistrationStatuses] } },
      },
    });
    const remaining = Math.max((claim.limit ?? 0) - occupied, 0);
    if (occupied + group.length > (claim.limit ?? 0)) {
      return {
        fits: false,
        reason: `${claim.optionValue} has ${remaining} remaining option spot${remaining === 1 ? "" : "s"}, but this registration needs ${group.length}.`,
        details: {
          fieldId: claim.fieldId,
          fieldKey: claim.fieldKey,
          optionValue: claim.optionValue,
          limit: claim.limit,
          occupied,
          requested: group.length,
          remaining,
        },
      };
    }
  }
  return { fits: true, reason: null, details: {} };
}

async function releaseOptionReservations(
  tx: Prisma.TransactionClient,
  registrationId: string,
  now: Date,
) {
  return tx.registrationCapacityReservation.updateMany({
    where: { registrationId, releasedAt: null },
    data: { releasedAt: now },
  });
}

async function activateOptionReservations(
  tx: Prisma.TransactionClient,
  registration: LifecycleRegistration,
  claims: ReservationClaim[],
  now: Date,
) {
  await releaseOptionReservations(tx, registration.id, now);
  let activated = 0;
  for (const claim of claims) {
    const existing = registration.capacityReservations.find((reservation) => (
      reservation.participantKey === claim.participantKey
      && reservation.fieldId === claim.fieldId
      && reservation.optionValue === claim.optionValue
    ));
    if (existing) {
      await tx.registrationCapacityReservation.update({
        where: { id: existing.id },
        data: {
          registrationAttendeeId: claim.registrationAttendeeId,
          rank: claim.rank,
          releasedAt: null,
        },
      });
    } else {
      await tx.registrationCapacityReservation.create({
        data: {
          eventId: claim.eventId,
          formId: claim.formId,
          formVersionId: claim.formVersionId,
          registrationId: claim.registrationId,
          registrationAttendeeId: claim.registrationAttendeeId,
          participantKey: claim.participantKey,
          fieldId: claim.fieldId,
          fieldKey: claim.fieldKey,
          optionValue: claim.optionValue,
          rank: claim.rank,
        },
      });
    }
    activated += 1;
  }
  return activated;
}

async function nextWaitlistPosition(tx: Prisma.TransactionClient, eventId: string) {
  const aggregate = await tx.registrationWaitlistEntry.aggregate({
    where: { eventId },
    _max: { position: true },
  });
  return (aggregate._max.position ?? 0) + 1;
}

async function placeAtEndOfWaitlist(
  tx: Prisma.TransactionClient,
  registration: LifecycleRegistration,
  now: Date,
) {
  const position = await nextWaitlistPosition(tx, registration.eventId);
  const data = {
    position,
    attendeeCount: registration.attendees.length,
    status: "WAITING" as const,
    lastBlockedReason: null,
    joinedAt: now,
    promotedAt: null,
    removedAt: null,
  };
  if (registration.waitlistEntry) {
    await tx.registrationWaitlistEntry.update({
      where: { id: registration.waitlistEntry.id },
      data,
    });
  } else {
    await tx.registrationWaitlistEntry.create({
      data: {
        eventId: registration.eventId,
        registrationId: registration.id,
        ...data,
      },
    });
  }
  return position;
}

async function auditTransition(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    actorUserId: string;
    registration: LifecycleRegistration;
    action: string;
    summary: string;
    fromStatus: RegistrationStatus;
    toStatus: RegistrationStatus;
    reason: string;
    correlationId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await tx.auditLog.create({
    data: {
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: "Registration",
      entityId: input.registration.id,
      correlationId: input.correlationId,
      summary: input.summary,
      metadata: {
        confirmationCode: input.registration.confirmationCode,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        reason: input.reason || null,
        ...(input.metadata ?? {}),
      },
    },
  });
}

async function promoteWithinTransaction(
  tx: Prisma.TransactionClient,
  registration: LifecycleRegistration,
  actorUserId: string,
  reason: string,
  now: Date,
  action: "REGISTRATION_PROMOTED_FROM_WAITLIST" | "REGISTRATION_AUTO_PROMOTED_FROM_WAITLIST",
  correlationId: string,
) {
  const claims = desiredReservationClaims(registration);
  const optionCapacity = await checkOptionCapacity(tx, registration, claims);
  if (!optionCapacity.fits) {
    throw new RegistrationLifecycleError(
      "OPTION_CAPACITY_UNAVAILABLE",
      optionCapacity.reason ?? "One or more registration options are no longer available.",
      optionCapacity.details,
    );
  }
  const activatedReservations = await activateOptionReservations(tx, registration, claims, now);
  await tx.registration.update({
    where: { id: registration.id },
    data: { status: "SUBMITTED", cancelledAt: null },
  });
  if (!registration.waitlistEntry) {
    throw new RegistrationLifecycleError(
      "WAITLIST_ENTRY_NOT_FOUND",
      "The waitlisted registration does not have a queue entry.",
    );
  }
  await tx.registrationWaitlistEntry.update({
    where: { id: registration.waitlistEntry.id },
    data: {
      status: "PROMOTED",
      promotedAt: now,
      removedAt: null,
      lastBlockedReason: null,
    },
  });
  await auditTransition(tx, {
    eventId: registration.eventId,
    actorUserId,
    registration,
    action,
    summary: `${action === "REGISTRATION_AUTO_PROMOTED_FROM_WAITLIST" ? "Automatically promoted" : "Promoted"} registration ${registration.confirmationCode} from the waitlist.`,
    fromStatus: "WAITLISTED",
    toStatus: "SUBMITTED",
    reason,
    correlationId,
    metadata: {
      waitlistPosition: registration.waitlistEntry.position,
      activatedReservations,
      totalAmountPreserved: true,
      paymentHistoryPreserved: true,
    },
  });
  return enqueueWaitlistPromotedMessage(tx, {
    eventId: registration.eventId,
    registrationId: registration.id,
    correlationId,
    transitionKey: `${action}:${correlationId}`,
    waitlistPosition: registration.waitlistEntry.position,
    metadata: {
      source: action,
      autoPromoted: action === "REGISTRATION_AUTO_PROMOTED_FROM_WAITLIST",
    },
  });
}

async function autoPromoteEarliestFitting(
  tx: Prisma.TransactionClient,
  event: LifecycleEvent,
  actorUserId: string,
  cancelledRegistration: LifecycleRegistration,
  now: Date,
  correlationId: string,
) {
  const waiting = await tx.registrationWaitlistEntry.findMany({
    where: { eventId: event.id, status: "WAITING" },
    orderBy: { position: "asc" },
    select: { id: true, registrationId: true, position: true },
  });

  for (const entry of waiting) {
    const candidate = await loadRegistration(tx, event.id, entry.registrationId);
    if (candidate.status !== "WAITLISTED" || candidate.waitlistEntry?.status !== "WAITING") {
      await tx.registrationWaitlistEntry.update({
        where: { id: entry.id },
        data: {
          lastBlockedReason: "Registration is no longer in a promotable waitlist state.",
        },
      });
      continue;
    }

    const eventCapacity = await checkEventCapacity(tx, event, candidate);
    if (!eventCapacity.fits) {
      await tx.registrationWaitlistEntry.update({
        where: { id: entry.id },
        data: { lastBlockedReason: eventCapacity.reason?.slice(0, 500) ?? "Event capacity is unavailable." },
      });
      continue;
    }

    let claims: ReservationClaim[];
    try {
      claims = desiredReservationClaims(candidate);
    } catch (error) {
      if (!(error instanceof RegistrationLifecycleError)) throw error;
      await tx.registrationWaitlistEntry.update({
        where: { id: entry.id },
        data: { lastBlockedReason: error.message.slice(0, 500) },
      });
      continue;
    }
    const optionCapacity = await checkOptionCapacity(tx, candidate, claims);
    if (!optionCapacity.fits) {
      await tx.registrationWaitlistEntry.update({
        where: { id: entry.id },
        data: { lastBlockedReason: optionCapacity.reason?.slice(0, 500) ?? "Option capacity is unavailable." },
      });
      continue;
    }

    const queued = await promoteWithinTransaction(
      tx,
      candidate,
      actorUserId,
      `Automatically promoted after cancellation of ${cancelledRegistration.confirmationCode}.`,
      now,
      "REGISTRATION_AUTO_PROMOTED_FROM_WAITLIST",
      correlationId,
    );
    return {
      registrationId: candidate.id,
      pendingMessageIds: queued.pendingMessageIds,
    };
  }
  return null;
}

function retryableTransactionError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || error.code === "P2002");
}

async function runSerializable<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!retryableTransactionError(error)) throw error;
    }
  }
  throw new RegistrationLifecycleError(
    "REGISTRATION_TRANSITION_CONFLICT",
    "Another lifecycle change updated this event at the same time. Refresh and try again.",
  );
}

async function registrationResult(eventId: string, registrationId: string) {
  const registration = await getRegistrationById(eventId, registrationId);
  if (!registration) {
    throw new RegistrationLifecycleError(
      "REGISTRATION_NOT_FOUND",
      "The registration could not be loaded after its lifecycle transition.",
    );
  }
  return registration;
}

export type CancelRegistrationResult = {
  registration: RegistrationRecord;
  autoPromotedRegistration: RegistrationRecord | null;
  pendingMessageIds: string[];
};

export async function cancelRegistration(
  eventId: string,
  registrationId: string,
  actorUserId: string,
  reason = "",
  now = new Date(),
): Promise<CancelRegistrationResult> {
  const result = await runSerializable(async (tx) => {
    const event = await loadEvent(tx, eventId);
    const registration = await loadRegistration(tx, eventId, registrationId);
    requireStatus(
      registration,
      ["DRAFT", "SUBMITTED", "CONFIRMED", "WAITLISTED"],
      "Cancellation",
    );
    const correlationId = crypto.randomUUID();
    const wasActive = isActiveStatus(registration.status);
    const released = await releaseOptionReservations(tx, registration.id, now);

    if (registration.status === "WAITLISTED" && registration.waitlistEntry) {
      await tx.registrationWaitlistEntry.update({
        where: { id: registration.waitlistEntry.id },
        data: {
          status: "REMOVED",
          removedAt: now,
          lastBlockedReason: reason || "Registration cancelled.",
        },
      });
    }
    await tx.registration.update({
      where: { id: registration.id },
      data: { status: "CANCELLED", cancelledAt: now },
    });

    const autoPromotion = wasActive
      && event.waitlistEnabled
      && event.autoPromoteWaitlist
      ? await autoPromoteEarliestFitting(
          tx,
          event,
          actorUserId,
          registration,
          now,
          correlationId,
        )
      : null;
    const autoPromotedRegistrationId = autoPromotion?.registrationId ?? null;

    await auditTransition(tx, {
      eventId,
      actorUserId,
      registration,
      action: "REGISTRATION_CANCELLED",
      summary: `Cancelled registration ${registration.confirmationCode}.`,
      fromStatus: registration.status,
      toStatus: "CANCELLED",
      reason,
      correlationId,
      metadata: {
        releasedReservations: released.count,
        autoPromotedRegistrationId,
        totalAmountPreserved: true,
        paymentHistoryPreserved: true,
      },
    });
    const cancellationMessage = await enqueueRegistrationCancelledMessage(tx, {
      eventId,
      registrationId: registration.id,
      correlationId,
      transitionKey: `REGISTRATION_CANCELLED:${correlationId}`,
      metadata: {
        source: "STAFF_LIFECYCLE",
        autoPromotedRegistrationId,
      },
    });
    return {
      registrationId: registration.id,
      autoPromotedRegistrationId,
      pendingMessageIds: [
        ...cancellationMessage.pendingMessageIds,
        ...(autoPromotion?.pendingMessageIds ?? []),
      ],
    };
  });

  return {
    registration: await registrationResult(eventId, result.registrationId),
    autoPromotedRegistration: result.autoPromotedRegistrationId
      ? await registrationResult(eventId, result.autoPromotedRegistrationId)
      : null,
    pendingMessageIds: result.pendingMessageIds,
  };
}

export async function moveRegistrationToWaitlist(
  eventId: string,
  registrationId: string,
  actorUserId: string,
  reason = "",
  now = new Date(),
) {
  const result = await runSerializable(async (tx) => {
    const event = await loadEvent(tx, eventId);
    if (!event.waitlistEnabled) {
      throw new RegistrationLifecycleError(
        "WAITLIST_NOT_ENABLED",
        "The event waitlist is not enabled.",
      );
    }
    const registration = await loadRegistration(tx, eventId, registrationId);
    requireStatus(registration, ["SUBMITTED", "CONFIRMED"], "Moving to the waitlist");
    const correlationId = crypto.randomUUID();
    const released = await releaseOptionReservations(tx, registration.id, now);
    const position = await placeAtEndOfWaitlist(tx, registration, now);
    await tx.registration.update({
      where: { id: registration.id },
      data: { status: "WAITLISTED", cancelledAt: null },
    });
    await auditTransition(tx, {
      eventId,
      actorUserId,
      registration,
      action: "REGISTRATION_MOVED_TO_WAITLIST",
      summary: `Moved registration ${registration.confirmationCode} to waitlist position ${position}.`,
      fromStatus: registration.status,
      toStatus: "WAITLISTED",
      reason,
      correlationId,
      metadata: {
        waitlistPosition: position,
        releasedReservations: released.count,
        totalAmountPreserved: true,
        paymentHistoryPreserved: true,
      },
    });
    const queued = await enqueueWaitlistJoinedMessage(tx, {
      eventId,
      registrationId: registration.id,
      correlationId,
      transitionKey: `REGISTRATION_MOVED_TO_WAITLIST:${correlationId}`,
      waitlistPosition: position,
      metadata: {
        source: "STAFF_LIFECYCLE",
        waitlistPosition: position,
      },
    });
    return {
      registrationId: registration.id,
      pendingMessageIds: queued.pendingMessageIds,
    };
  });
  return {
    registration: await registrationResult(eventId, result.registrationId),
    pendingMessageIds: result.pendingMessageIds,
  };
}

export async function promoteRegistrationFromWaitlist(
  eventId: string,
  registrationId: string,
  actorUserId: string,
  reason = "",
  now = new Date(),
) {
  const result = await runSerializable(async (tx) => {
    const event = await loadEvent(tx, eventId);
    const registration = await loadRegistration(tx, eventId, registrationId);
    requireStatus(registration, ["WAITLISTED"], "Promotion");
    if (!registration.waitlistEntry || registration.waitlistEntry.status !== "WAITING") {
      throw new RegistrationLifecycleError(
        "WAITLIST_ENTRY_NOT_FOUND",
        "The registration does not have an active waitlist entry.",
      );
    }
    const eventCapacity = await checkEventCapacity(tx, event, registration);
    if (!eventCapacity.fits) {
      throw new RegistrationLifecycleError(
        "EVENT_CAPACITY_UNAVAILABLE",
        eventCapacity.reason ?? "The event does not have enough capacity.",
        eventCapacity.details,
      );
    }
    const correlationId = crypto.randomUUID();
    const queued = await promoteWithinTransaction(
      tx,
      registration,
      actorUserId,
      reason,
      now,
      "REGISTRATION_PROMOTED_FROM_WAITLIST",
      correlationId,
    );
    return {
      registrationId: registration.id,
      pendingMessageIds: queued.pendingMessageIds,
    };
  });
  return {
    registration: await registrationResult(eventId, result.registrationId),
    pendingMessageIds: result.pendingMessageIds,
  };
}

export async function reactivateRegistration(
  eventId: string,
  registrationId: string,
  actorUserId: string,
  reason = "",
  now = new Date(),
) {
  const id = await runSerializable(async (tx) => {
    const event = await loadEvent(tx, eventId);
    const registration = await loadRegistration(tx, eventId, registrationId);
    requireStatus(registration, ["CANCELLED"], "Reactivation");
    const eventCapacity = await checkEventCapacity(tx, event, registration);
    if (!eventCapacity.fits) {
      throw new RegistrationLifecycleError(
        "EVENT_CAPACITY_UNAVAILABLE",
        eventCapacity.reason ?? "The event does not have enough capacity.",
        eventCapacity.details,
      );
    }
    const claims = desiredReservationClaims(registration);
    const optionCapacity = await checkOptionCapacity(tx, registration, claims);
    if (!optionCapacity.fits) {
      throw new RegistrationLifecycleError(
        "OPTION_CAPACITY_UNAVAILABLE",
        optionCapacity.reason ?? "One or more registration options are no longer available.",
        optionCapacity.details,
      );
    }

    const previousCancellation = await tx.auditLog.findFirst({
      where: {
        eventId,
        entityType: "Registration",
        entityId: registration.id,
        action: "REGISTRATION_CANCELLED",
      },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    });
    const priorStatus = recordFromJson(previousCancellation?.metadata).fromStatus;
    const targetStatus = priorStatus === "CONFIRMED" ? "CONFIRMED" : "SUBMITTED";
    const activatedReservations = await activateOptionReservations(tx, registration, claims, now);
    await tx.registration.update({
      where: { id: registration.id },
      data: { status: targetStatus, cancelledAt: null },
    });
    if (registration.waitlistEntry?.status === "REMOVED") {
      await tx.registrationWaitlistEntry.update({
        where: { id: registration.waitlistEntry.id },
        data: {
          status: "PROMOTED",
          promotedAt: now,
          removedAt: null,
          lastBlockedReason: null,
        },
      });
    }
    await auditTransition(tx, {
      eventId,
      actorUserId,
      registration,
      action: "REGISTRATION_REACTIVATED",
      summary: `Reactivated registration ${registration.confirmationCode}.`,
      fromStatus: "CANCELLED",
      toStatus: targetStatus,
      reason,
      correlationId: crypto.randomUUID(),
      metadata: {
        activatedReservations,
        restoredStatus: targetStatus,
        totalAmountPreserved: true,
        paymentHistoryPreserved: true,
      },
    });
    return registration.id;
  });
  return registrationResult(eventId, id);
}
