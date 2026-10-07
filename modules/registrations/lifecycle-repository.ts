import "server-only";

import { countLocationSeats, lockEventLocation } from "@/modules/event-locations/admission";
import { locationHasRoom, remainingLocationSeats } from "@/modules/event-locations/domain";
import { EventLocationError, locationTransactionTimeoutMs } from "@/modules/event-locations/errors";
import { noteLodgingOnAdmission } from "@/modules/lodging/registration-form";
import { locationWaitlistPlace, recordLocationWaitlistChange } from "@/modules/event-locations/waitlist";

import { Prisma, type RegistrationStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { logWarn } from "@/lib/logger";
import { isSerializationFailure, pauseBeforeRetry } from "@/lib/prisma-errors";
import { refreshBackgroundCheckMatchesForRegistrations } from "@/modules/background-checks/refresh-after-write";
import {
  enqueueRegistrationCancelledMessage,
  enqueueRegistrationReactivatedMessage,
  enqueueWaitlistJoinedMessage,
  enqueueWaitlistPromotedMessage,
  enqueueWaitlistRemovedMessage,
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
  if (decision !== "REGISTER") {
    return {
      fits: false,
      reason: `The event has ${remaining ?? 0} remaining spot${remaining === 1 ? "" : "s"}, but this registration needs ${requested}.`,
      details: { occupied, requested, remaining },
    };
  }
  // A registration at a location of a multi-location event also needs room
  // there (#413): the location row is locked and its seats counted like the
  // event's, so promoting or restoring can't overfill a location.
  const locationId = (registration as { locationId?: string | null }).locationId;
  if (locationId) {
    const location = await lockEventLocation(tx, event.id, locationId);
    if (location) {
      const locationOccupied = await countLocationSeats(tx, location.id, registration.id);
      if (!locationHasRoom(location.capacity, locationOccupied, requested)) {
        const locationRemaining = remainingLocationSeats(location.capacity, locationOccupied);
        return {
          fits: false,
          reason: `${location.name} has ${locationRemaining ?? 0} remaining spot${locationRemaining === 1 ? "" : "s"}, but this registration needs ${requested}.`,
          details: { occupied: locationOccupied, requested, remaining: locationRemaining, locationId: location.id },
        };
      }
    }
  }
  return { fits: true, reason: null, details: { occupied, requested, remaining } };
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
    actorUserId: string | null;
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
  actorUserId: string | null,
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
  // Where the club stood at its location, read while it is still waitlisted and waiting (#599).
  const locationPlace = await locationWaitlistPlace(tx, registration.id, registration.locationId);
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
  // A lodging request starts counting as demand again. This never blocks or changes the promotion and never charges; the
  // lodging review queue lists the request as unconfirmed when it no longer fits or carries no lodging line (#199).
  const lodging = await noteLodgingOnAdmission(tx, registration.eventId, registration.id);
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
      lodgingRequestHeld: lodging.hasRequest,
    },
  });
  await recordLocationWaitlistChange(tx, {
    registrationId: registration.id,
    locationId: registration.locationId,
    kind: "PROMOTED",
    place: locationPlace,
    now,
  });
  return enqueueWaitlistPromotedMessage(tx, {
    eventId: registration.eventId,
    registrationId: registration.id,
    correlationId,
    transitionKey: `${action}:${correlationId}`,
    waitlistPosition: locationPlace ?? registration.waitlistEntry.position,
    metadata: {
      source: action,
      autoPromoted: action === "REGISTRATION_AUTO_PROMOTED_FROM_WAITLIST",
    },
  });
}

const maximumPromotionRounds = 50;
const maxRetryAttempts = 6;

/**
 * Records why a waiting club was not promoted, unless that is already what the
 * entry says. Concurrent promotion passes then do not each write the same row
 * (and wait on each other outside a savepoint) just to repeat a reason.
 */
async function noteBlocked(tx: Prisma.TransactionClient, entryId: string, currentReason: string | null, reason: string) {
  if (currentReason === reason) return;
  await tx.registrationWaitlistEntry.update({ where: { id: entryId }, data: { lastBlockedReason: reason } });
}

/** What freed seats: the location they were at (if any) decides who is offered them first. */
export type SeatsFreedTrigger = { locationId: string | null; reason: string };

async function autoPromoteEarliestFitting(
  tx: Prisma.TransactionClient,
  event: LifecycleEvent,
  actorUserId: string | null,
  trigger: SeatsFreedTrigger,
  now: Date,
  correlationId: string,
  /** Locations found busy earlier in this transaction: skipped, so a repeating pass does not wait on them again. */
  busyLocationIds: Set<string> = new Set(),
) {
  const queued = await tx.registrationWaitlistEntry.findMany({
    where: { eventId: event.id, status: "WAITING" },
    orderBy: { position: "asc" },
    select: { id: true, registrationId: true, position: true, registration: { select: { locationId: true } } },
  });
  // Seats freed at a location go to the next club waiting at that location
  // first, in its own first-come order (#599). Clubs at other locations, or
  // with none, follow in event order: the freed event seat may help them too.
  const waiting = trigger.locationId
    ? [
        ...queued.filter((entry) => entry.registration?.locationId === trigger.locationId),
        ...queued.filter((entry) => entry.registration?.locationId !== trigger.locationId),
      ]
    : queued;

  for (const entry of waiting) {
    const entryLocationId = entry.registration?.locationId;
    if (entryLocationId && busyLocationIds.has(entryLocationId)) continue;
    const candidate = await loadRegistration(tx, event.id, entry.registrationId);
    const currentReason = candidate.waitlistEntry?.lastBlockedReason ?? null;
    if (candidate.status !== "WAITLISTED" || candidate.waitlistEntry?.status !== "WAITING") {
      await noteBlocked(tx, entry.id, currentReason, "Registration is no longer in a promotable waitlist state.");
      continue;
    }

    // A candidate at a location takes that location's row lock. If another
    // request holds it past the lock wait, this candidate is blocked for now
    // and the cancellation itself still succeeds (#413). The savepoint keeps
    // the failed lock wait from aborting the whole transaction.
    const locationSavepoint = (candidate as { locationId?: string | null }).locationId;
    if (locationSavepoint) await tx.$executeRawUnsafe("SAVEPOINT auto_promote_candidate");
    let eventCapacity: CapacityCheck;
    try {
      eventCapacity = await checkEventCapacity(tx, event, candidate);
    } catch (error) {
      if (!locationSavepoint || !(error instanceof EventLocationError && error.code === "LOCATION_BUSY")) throw error;
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT auto_promote_candidate");
      busyLocationIds.add(locationSavepoint);
      await noteBlocked(tx, entry.id, currentReason, "The registration's location was busy, so it was not promoted automatically. Promote it by hand.");
      continue;
    }
    if (locationSavepoint) await tx.$executeRawUnsafe("RELEASE SAVEPOINT auto_promote_candidate");
    if (!eventCapacity.fits) {
      await noteBlocked(tx, entry.id, currentReason, eventCapacity.reason?.slice(0, 500) ?? "Event capacity is unavailable.");
      continue;
    }

    let claims: ReservationClaim[];
    try {
      claims = desiredReservationClaims(candidate);
    } catch (error) {
      if (!(error instanceof RegistrationLifecycleError)) throw error;
      await noteBlocked(tx, entry.id, currentReason, error.message.slice(0, 500));
      continue;
    }
    const optionCapacity = await checkOptionCapacity(tx, candidate, claims);
    if (!optionCapacity.fits) {
      await noteBlocked(tx, entry.id, currentReason, optionCapacity.reason?.slice(0, 500) ?? "Option capacity is unavailable.");
      continue;
    }

    const queued = await promoteWithinTransaction(
      tx,
      candidate,
      actorUserId,
      trigger.reason,
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

/**
 * Offers seats that opened at a location to the waitlist, inside the caller's
 * transaction (#599): an amendment that removed people or moved a club away, a
 * club transfer out, or a raised capacity. It is the same loop a cancellation
 * uses, so each candidate's location is locked inside it and a busy location
 * is skipped rather than failing the change that freed the seats.
 *
 * Does nothing when the event has no waitlist or auto-promotion is off.
 * `repeat` keeps promoting while the next club still fits (a raised capacity
 * can open several seats at once); the default offers the seats to one club.
 * The caller sends the returned `pendingMessageIds` after its commit.
 */
export async function promoteWaitlistAfterSeatsFreed(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    actorUserId: string | null;
    trigger: SeatsFreedTrigger;
    now?: Date;
    correlationId?: string;
    repeat?: boolean;
  },
) {
  const promotedRegistrationIds: string[] = [];
  const pendingMessageIds: string[] = [];
  const event = await loadEvent(tx, input.eventId);
  if (!event.waitlistEnabled || !event.autoPromoteWaitlist) {
    return { promotedRegistrationIds, pendingMessageIds };
  }
  const now = input.now ?? new Date();
  const correlationId = input.correlationId ?? crypto.randomUUID();
  // A promotion needs a waiting club; the bound only guards a runaway loop.
  const busyLocationIds = new Set<string>();
  for (let round = 0; round < maximumPromotionRounds; round += 1) {
    const promoted = await autoPromoteEarliestFitting(tx, event, input.actorUserId, input.trigger, now, `${correlationId}:${round}`, busyLocationIds);
    if (!promoted) break;
    promotedRegistrationIds.push(promoted.registrationId);
    pendingMessageIds.push(...promoted.pendingMessageIds);
    if (!input.repeat) break;
    if (round === maximumPromotionRounds - 1) {
      logWarn("Waitlist promotion stopped at its round limit with clubs possibly still waiting.", { eventId: input.eventId, rounds: maximumPromotionRounds });
    }
  }
  return { promotedRegistrationIds, pendingMessageIds };
}

function retryableTransactionError(error: unknown) {
  // A location's row lock is a raw query, whose serialization failure is not P2034 (#599).
  return isSerializationFailure(error)
    || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002");
}

async function runSerializable<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < maxRetryAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // Promoting or restoring may wait up to 5s on a location's row lock (#413).
        timeout: locationTransactionTimeoutMs,
      });
    } catch (error) {
      if (!retryableTransactionError(error)) throw error;
      if (attempt < maxRetryAttempts - 1) await pauseBeforeRetry(attempt);
    }
  }
  throw new RegistrationLifecycleError(
    "REGISTRATION_TRANSITION_CONFLICT",
    "Another lifecycle change updated this event at the same time. Refresh and try again.",
  );
}

async function registrationResult(eventId: string, registrationId: string) {
  // #527: a status change moves people in or out of the Sterling Volunteers
  // candidate pool (active registrations only); refresh after commit, best effort.
  await refreshBackgroundCheckMatchesForRegistrations([registrationId]);
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
    const wasWaitlisted = registration.status === "WAITLISTED";
    // At a location the place in line is per location (#599); read before the entry is removed.
    const locationPlace = wasWaitlisted && registration.waitlistEntry?.status === "WAITING"
      ? await locationWaitlistPlace(tx, registration.id, registration.locationId)
      : null;
    const waitlistPosition = wasWaitlisted
      ? locationPlace ?? registration.waitlistEntry?.position ?? null
      : null;
    const released = await releaseOptionReservations(tx, registration.id, now);

    if (wasWaitlisted && registration.waitlistEntry) {
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
    if (wasWaitlisted && registration.waitlistEntry) {
      await recordLocationWaitlistChange(tx, {
        registrationId: registration.id,
        locationId: registration.locationId,
        kind: "REMOVED",
        place: locationPlace,
        now,
      });
    }

    const autoPromotion = wasActive
      && event.waitlistEnabled
      && event.autoPromoteWaitlist
      ? await autoPromoteEarliestFitting(
          tx,
          event,
          actorUserId,
          {
            locationId: registration.locationId,
            reason: `Automatically promoted after cancellation of ${registration.confirmationCode}.`,
          },
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
        ...(wasWaitlisted ? { waitlistPosition } : {}),
        totalAmountPreserved: true,
        paymentHistoryPreserved: true,
      },
    });
    const cancellationMessage = await (wasWaitlisted
      ? enqueueWaitlistRemovedMessage
      : enqueueRegistrationCancelledMessage)(tx, {
      eventId,
      registrationId: registration.id,
      correlationId,
      transitionKey: `REGISTRATION_CANCELLED:${correlationId}`,
      waitlistPosition,
      waitlistRemovalReason: reason,
      metadata: {
        source: "STAFF_LIFECYCLE",
        autoPromotedRegistrationId,
        ...(wasWaitlisted ? { waitlistPosition, reason: reason || null } : {}),
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
    const eventPosition = await placeAtEndOfWaitlist(tx, registration, now);
    await tx.registration.update({
      where: { id: registration.id },
      data: { status: "WAITLISTED", cancelledAt: null },
    });
    // At a location the place in line is per location, and the joined notice to
    // the coordinator and staff is recorded (#599).
    const locationPlace = await locationWaitlistPlace(tx, registration.id, registration.locationId);
    const position = locationPlace ?? eventPosition;
    if (locationPlace !== null) {
      await recordLocationWaitlistChange(tx, { registrationId: registration.id, locationId: registration.locationId, kind: "JOINED", place: locationPlace, now });
    }
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
  const result = await runSerializable(async (tx) => {
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
    const correlationId = crypto.randomUUID();
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
    // A reinstated registration's lodging request counts as demand again: same locks and capacityVersion bump, no charge.
    await noteLodgingOnAdmission(tx, eventId, registration.id);
    await auditTransition(tx, {
      eventId,
      actorUserId,
      registration,
      action: "REGISTRATION_REACTIVATED",
      summary: `Reactivated registration ${registration.confirmationCode}.`,
      fromStatus: "CANCELLED",
      toStatus: targetStatus,
      reason,
      correlationId,
      metadata: {
        activatedReservations,
        restoredStatus: targetStatus,
        totalAmountPreserved: true,
        paymentHistoryPreserved: true,
      },
    });
    const queued = await enqueueRegistrationReactivatedMessage(tx, {
      eventId,
      registrationId: registration.id,
      correlationId,
      transitionKey: `REGISTRATION_REACTIVATED:${correlationId}`,
      metadata: {
        source: "STAFF_LIFECYCLE",
        restoredStatus: targetStatus,
        activatedReservations,
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
