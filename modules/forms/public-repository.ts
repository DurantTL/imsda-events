import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma, RegistrationFormStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  enqueuePublicRegistrationMessages,
  processQueuedMessageIdsAfterCommit,
} from "@/modules/communications/messaging-repository";
import { enqueueWaitlistJoinedMessage } from "@/modules/communications/transactional-messages";
import {
  getAttendeeRosterConfig,
  getAvailabilityMode,
  isChoiceFieldType,
  isFieldVisible,
  registrationFormDefinitionSchema,
  summarizeChoiceUsage,
  type ChoiceUsage,
  type FormCalculation,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import {
  calendarDateInTimeZone,
  preparePublicRegistration,
  type PreparedPublicAttendee,
  type PublicContactIdentity,
  type PublicRegistrationInput,
  type PublicRegistrationIssue,
} from "@/modules/forms/public-domain";
import {
  activeRegistrationStatuses,
  evaluateEventRegistrationAdmission,
  evaluateEventRegistrationPhase,
  type CapacityDecision,
  type EventRegistrationPhase,
} from "@/modules/events/lifecycle";
import { issueRegistrationAccessToken } from "@/modules/public-access/repository";
import {
  applyPromoCodeToCalculation,
  promoCodeField,
} from "@/modules/promo-codes/domain";
import {
  claimPromoCode,
  PromoCodeOperationError,
  PublicPromoCodeError,
  recordPromoCodeRedemption,
  type ClaimedPromoCode,
} from "@/modules/promo-codes/repository";

export type PublicRegistrationErrorCode =
  | "FORM_NOT_FOUND"
  | "FORM_VERSION_CHANGED"
  | "INVALID_SUBMISSION"
  | "CAPACITY_REACHED"
  | "EVENT_FULL"
  | "REGISTRATION_NOT_OPEN"
  | "REGISTRATION_CLOSED"
  | "IDEMPOTENCY_CONFLICT"
  | "SUBMISSION_CONFLICT";

export class PublicRegistrationError extends Error {
  constructor(
    public readonly code: PublicRegistrationErrorCode,
    message: string,
    public readonly issues: PublicRegistrationIssue[] = [],
  ) {
    super(message);
    this.name = "PublicRegistrationError";
  }
}

type PricingSnapshot = {
  currency: "USD";
  formVersionId: string;
  eventTimeZone: string;
  pricingDate: string;
  lineItems: FormCalculation["lineItems"];
  preDiscountSubtotalCents?: number;
  discountAmountCents?: number;
  promoCode?: string | null;
  subtotalCents: number;
  processingFeeCents: number;
  totalCents: number;
  cardSelected: boolean;
  paymentCollected: false;
  attendeeCount?: number;
  attendeeNames?: string[];
  registrationStatus?: "SUBMITTED" | "WAITLISTED";
  paymentEligible?: boolean;
  waitlistPosition?: number | null;
};

export type PublicRegistrationConfirmation = {
  confirmationCode: string;
  message: string;
  email: string;
  totalCents: number;
  subtotalCents: number;
  preDiscountSubtotalCents: number;
  discountAmountCents: number;
  promoCode: string | null;
  processingFeeCents: number;
  lineItems: FormCalculation["lineItems"];
  pricingDate: string;
  cardSelected: boolean;
  emailSent: boolean;
  paymentCollected: false;
  notificationQueued: boolean;
  notificationStatus: "PENDING" | "CAPTURED" | "SENT" | "FAILED" | "DISABLED";
  managePath: string | null;
  manageLinkExpiresAt: string | null;
  attendeeCount: number;
  attendeeNames: string[];
  registrationStatus: "SUBMITTED" | "WAITLISTED";
  capacityDecision: Exclude<CapacityDecision, "FULL">;
  paymentEligible: boolean;
  waitlistPosition: number | null;
};

export type PublicRegistrationExperience = {
  event: {
    name: string;
    slug: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
    location: string | null;
    capacity: number | null;
    registrationOpensOn: string | null;
    registrationClosesOn: string | null;
    waitlistEnabled: boolean;
  };
  form: {
    slug: string;
    versionId: string;
    versionNumber: number;
    definition: RegistrationFormDefinition;
  };
  choiceUsage: ChoiceUsage;
  pricingDate: string;
  lifecycle: {
    phase: EventRegistrationPhase;
    capacityDecision: CapacityDecision | null;
    remainingSpots: number | null;
    waitingRegistrations: number;
  };
};

const publicEventSelect = {
  id: true,
  name: true,
  slug: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  location: true,
  capacity: true,
  isPublished: true,
  registrationOpensOn: true,
  registrationClosesOn: true,
  waitlistEnabled: true,
} satisfies Prisma.EventSelect;

function publishedFormQuery(eventSlug: string, formSlug: string) {
  return {
    where: { slug: formSlug, event: { slug: eventSlug, isPublished: true } },
    select: {
      id: true,
      slug: true,
      eventId: true,
      event: { select: publicEventSelect },
      versions: {
        where: { status: RegistrationFormStatus.PUBLISHED },
        orderBy: { versionNumber: "desc" as const },
        take: 1,
        select: { id: true, versionNumber: true, definition: true, publishedAt: true },
      },
    },
  } satisfies Prisma.RegistrationFormFindFirstArgs;
}

function definitionFromJson(value: Prisma.JsonValue) {
  return registrationFormDefinitionSchema.parse(value);
}

function responsesFromJson(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pricingSnapshotFromJson(value: Prisma.JsonValue): PricingSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored public pricing snapshot is invalid.");
  return value as unknown as PricingSnapshot;
}

function attendeeResponsesFromJson(value: Prisma.JsonValue): PublicRegistrationInput["attendees"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const responses = record.responses;
    if (!responses || typeof responses !== "object" || Array.isArray(responses)) return [];
    return [{
      clientId: typeof record.clientId === "string" && record.clientId ? record.clientId : `stored-attendee-${index + 1}`,
      responses: responses as Record<string, unknown>,
    }];
  });
}

function usageFromReservations(
  definition: RegistrationFormDefinition,
  reservations: Array<{ fieldId: string; optionValue: string; rank: number | null }>,
) {
  const usage = summarizeChoiceUsage(definition, []);
  const fieldsById = new Map(definition.sections.flatMap((section) => section.fields).map((field) => [field.id, field]));
  for (const reservation of reservations) {
    const field = fieldsById.get(reservation.fieldId);
    if (!field || !usage[field.key]?.[reservation.optionValue]) continue;
    const stats = usage[field.key][reservation.optionValue];
    stats.total += 1;
    if (reservation.rank === 0) stats.first += 1;
    if (reservation.rank === 1) stats.second += 1;
  }
  return usage;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function submissionHash(input: PublicRegistrationInput) {
  const semanticInput = input.attendees
    ? {
        versionId: input.versionId,
        responses: input.responses,
        attendees: input.attendees.map((attendee) => attendee.responses),
      }
    : { versionId: input.versionId, responses: input.responses };
  return createHash("sha256").update(stableJson(semanticInput)).digest("hex");
}

function selectedCapacityChoices(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  attendees: Array<{ attendeeId: string; responses: Record<string, unknown> }>,
) {
  const selections: Array<{
    fieldId: string;
    fieldKey: string;
    optionValue: string;
    rank: number | null;
    participantKey: string;
    registrationAttendeeId: string | null;
  }> = [];
  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (!isChoiceFieldType(field.type) || getAvailabilityMode(field) === "NONE") continue;
      const participants = field.scope === "REGISTRATION"
        ? [{ attendeeId: null, participantKey: "registration", responses: registrationResponses }]
        : attendees.map((attendee) => ({
            attendeeId: attendee.attendeeId,
            participantKey: attendee.attendeeId,
            responses: { ...registrationResponses, ...attendee.responses },
          }));
      for (const participant of participants) {
        if (!isFieldVisible(field, participant.responses)) continue;
        const value = participant.responses[field.key];
        const options = Array.isArray(value) ? value.map(String) : typeof value === "string" && value ? [value] : [];
        options.forEach((optionValue, rank) => selections.push({
          fieldId: field.id,
          fieldKey: field.key,
          optionValue,
          rank: field.type === "RANKED_CHOICE" ? rank : null,
          participantKey: participant.participantKey,
          registrationAttendeeId: participant.attendeeId,
        }));
      }
    }
  }
  return selections.sort((left, right) => `${left.participantKey}\u0000${left.fieldId}\u0000${left.optionValue}`.localeCompare(`${right.participantKey}\u0000${right.fieldId}\u0000${right.optionValue}`));
}

function attendeeType(responses: Record<string, unknown>) {
  const value = String(responses.attendee_type ?? "").toLowerCase();
  if (value.includes("worker") || value.includes("volunteer")) return "WORKER";
  if (value.includes("child") || value.includes("teen") || value.includes("youth")) return "CHILD";
  return "ATTENDEE";
}

function isCardSelected(definition: RegistrationFormDefinition, responses: Record<string, unknown>) {
  const payment = definition.payment;
  return Boolean(payment?.enabled && responses[payment.paymentMethodFieldKey] === payment.cardOptionValue);
}

function samePersonName(
  left: { firstName: string; lastName: string },
  right: { firstName: string; lastName: string },
) {
  return left.firstName.trim().toLowerCase() === right.firstName.trim().toLowerCase()
    && left.lastName.trim().toLowerCase() === right.lastName.trim().toLowerCase();
}

async function resolveAttendeePerson(
  tx: Prisma.TransactionClient,
  attendee: NonNullable<PreparedPublicAttendee["identity"]>,
  accountHolder: { id: string; firstName: string; lastName: string; normalizedEmail: string | null },
  usedPersonIds: Set<string>,
) {
  if (
    !usedPersonIds.has(accountHolder.id)
    && samePersonName(attendee, accountHolder)
    && (!attendee.email || attendee.email === accountHolder.normalizedEmail)
  ) {
    usedPersonIds.add(accountHolder.id);
    return accountHolder;
  }
  if (attendee.email) {
    const existing = await tx.person.findUnique({ where: { normalizedEmail: attendee.email } });
    if (existing && samePersonName(attendee, existing) && !usedPersonIds.has(existing.id)) {
      usedPersonIds.add(existing.id);
      return existing;
    }
  }
  const created = await tx.person.create({
    data: {
      firstName: attendee.firstName,
      lastName: attendee.lastName,
      normalizedEmail: attendee.email && !await tx.person.findUnique({ where: { normalizedEmail: attendee.email }, select: { id: true } })
        ? attendee.email
        : null,
      phone: attendee.phone || null,
    },
  });
  usedPersonIds.add(created.id);
  return created;
}

function confirmationFromSnapshot(
  definition: RegistrationFormDefinition,
  confirmationCode: string,
  email: string,
  snapshot: PricingSnapshot,
  notificationStatus: PublicRegistrationConfirmation["notificationStatus"],
  registrationStatus: PublicRegistrationConfirmation["registrationStatus"] = snapshot.registrationStatus ?? "SUBMITTED",
  waitlistPosition: number | null = snapshot.waitlistPosition ?? null,
): PublicRegistrationConfirmation {
  const isWaitlisted = registrationStatus === "WAITLISTED";
  return {
    confirmationCode,
    message: isWaitlisted
      ? "You have joined the event waitlist. This is not a confirmed registration, and no payment was collected."
      : definition.confirmationMessage,
    email,
    totalCents: snapshot.totalCents,
    subtotalCents: snapshot.subtotalCents,
    preDiscountSubtotalCents:
      snapshot.preDiscountSubtotalCents ?? snapshot.subtotalCents,
    discountAmountCents: snapshot.discountAmountCents ?? 0,
    promoCode: snapshot.promoCode ?? null,
    processingFeeCents: snapshot.processingFeeCents,
    lineItems: snapshot.lineItems,
    pricingDate: snapshot.pricingDate,
    cardSelected: !isWaitlisted && snapshot.cardSelected,
    emailSent: false,
    paymentCollected: false,
    notificationQueued: notificationStatus !== "DISABLED",
    notificationStatus,
    managePath: null,
    manageLinkExpiresAt: null,
    attendeeCount: snapshot.attendeeCount ?? 1,
    attendeeNames: snapshot.attendeeNames ?? [],
    registrationStatus,
    capacityDecision: isWaitlisted ? "WAITLIST" : "REGISTER",
    paymentEligible: snapshot.paymentEligible ?? !isWaitlisted,
    waitlistPosition: isWaitlisted ? waitlistPosition : null,
  };
}

export async function getPublicRegistrationExperience(eventSlug: string, formSlug: string): Promise<PublicRegistrationExperience | null> {
  const prisma = getPrisma();
  const form = await prisma.registrationForm.findFirst(publishedFormQuery(eventSlug, formSlug));
  const version = form?.versions[0];
  if (!form || !version) return null;
  const definition = definitionFromJson(version.definition);
  const now = new Date();
  const [reservations, occupied, waitingRegistrations] = await Promise.all([
    prisma.registrationCapacityReservation.findMany({
      where: { formId: form.id, releasedAt: null },
      select: { fieldId: true, optionValue: true, rank: true },
    }),
    prisma.registrationAttendee.count({
      where: {
        eventId: form.eventId,
        registration: { status: { in: [...activeRegistrationStatuses] } },
      },
    }),
    prisma.registrationWaitlistEntry.count({
      where: { eventId: form.eventId, status: "WAITING" },
    }),
  ]);
  const pricingDate = calendarDateInTimeZone(now, form.event.timezone);
  const admission = evaluateEventRegistrationAdmission(
    form.event,
    { occupied, requested: getAttendeeRosterConfig(definition).minAttendees },
    now,
  );

  return {
    event: {
      name: form.event.name,
      slug: form.event.slug,
      startsAt: form.event.startsAt.toISOString(),
      endsAt: form.event.endsAt.toISOString(),
      timezone: form.event.timezone,
      location: form.event.location,
      capacity: form.event.capacity,
      registrationOpensOn: form.event.registrationOpensOn,
      registrationClosesOn: form.event.registrationClosesOn,
      waitlistEnabled: form.event.waitlistEnabled,
    },
    form: { slug: form.slug, versionId: version.id, versionNumber: version.versionNumber, definition },
    choiceUsage: usageFromReservations(definition, reservations),
    pricingDate,
    lifecycle: {
      ...admission,
      waitingRegistrations,
    },
  };
}

async function findExistingConfirmation(
  tx: Prisma.TransactionClient,
  formVersionId: string,
  idempotencyKey: string,
  requestHash: string,
  definition: RegistrationFormDefinition,
) {
  const existing = await tx.publicRegistrationSubmission.findUnique({
    where: { formVersionId_idempotencyKey: { formVersionId, idempotencyKey } },
    include: {
      registration: {
        select: {
          confirmationCode: true,
          status: true,
          waitlistEntry: { select: { position: true } },
        },
      },
    },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new PublicRegistrationError("IDEMPOTENCY_CONFLICT", "This submission key was already used for different answers. Refresh the form before trying again.");
  }
  const identity = preparePublicRegistration(definition, {
    versionId: formVersionId,
    idempotencyKey,
    responses: responsesFromJson(existing.responses),
    attendees: attendeeResponsesFromJson(existing.attendeeResponses),
    website: "",
  }, { timeZone: pricingSnapshotFromJson(existing.pricingSnapshot).eventTimeZone }).identity;
  const messages = await tx.messageOutbox.findMany({
    where: { registrationId: existing.registrationId, recipientKind: "REGISTRANT" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
  const notificationStatus: PublicRegistrationConfirmation["notificationStatus"] = messages.some((message) => message.status === "CAPTURED")
    ? "CAPTURED"
    : messages.some((message) => message.status === "PENDING")
      ? "PENDING"
      : "DISABLED";
  return {
    confirmation: confirmationFromSnapshot(
      definition,
      existing.registration.confirmationCode,
      identity?.email ?? "",
      pricingSnapshotFromJson(existing.pricingSnapshot),
      notificationStatus,
      existing.registration.status === "WAITLISTED" ? "WAITLISTED" : "SUBMITTED",
      existing.registration.waitlistEntry?.position ?? null,
    ),
    pendingMessageIds: messages.filter((message) => message.status === "PENDING").map((message) => message.id),
    registrantMessageIds: messages.map((message) => message.id),
  };
}

async function createPublicRegistrationTransaction(
  tx: Prisma.TransactionClient,
  eventSlug: string,
  formSlug: string,
  input: PublicRegistrationInput,
  now: Date,
) {
  const form = await tx.registrationForm.findFirst(publishedFormQuery(eventSlug, formSlug));
  const version = form?.versions[0];
  if (!form || !version) throw new PublicRegistrationError("FORM_NOT_FOUND", "That public registration form is not available.");
  if (version.id !== input.versionId) {
    throw new PublicRegistrationError("FORM_VERSION_CHANGED", "This form was updated while it was open. Refresh the page before submitting.");
  }

  const definition = definitionFromJson(version.definition);
  const requestHash = submissionHash(input);
  const replay = await findExistingConfirmation(tx, version.id, input.idempotencyKey, requestHash, definition);
  if (replay) return replay;

  const phase = evaluateEventRegistrationPhase(form.event, now);
  if (phase === "UPCOMING") {
    const opening = form.event.registrationOpensOn
      ? ` Registration opens on ${form.event.registrationOpensOn} in the event timezone.`
      : "";
    throw new PublicRegistrationError(
      "REGISTRATION_NOT_OPEN",
      `Registration for this event is not open yet.${opening}`,
    );
  }
  if (phase === "CLOSED") {
    const closing = form.event.registrationClosesOn
      ? ` Registration closed after ${form.event.registrationClosesOn} in the event timezone.`
      : "";
    throw new PublicRegistrationError(
      "REGISTRATION_CLOSED",
      `Registration for this event is closed.${closing}`,
    );
  }
  if (phase !== "OPEN") {
    throw new PublicRegistrationError("FORM_NOT_FOUND", "That public registration form is not available.");
  }

  const roster = getAttendeeRosterConfig(definition);
  const requestedAttendees = roster.enabled ? input.attendees?.length ?? 0 : 1;
  const occupied = await tx.registrationAttendee.count({
    where: {
      eventId: form.eventId,
      registration: { status: { in: [...activeRegistrationStatuses] } },
    },
  });
  const admission = evaluateEventRegistrationAdmission(
    form.event,
    { occupied, requested: requestedAttendees },
    now,
  );
  if (admission.capacityDecision === "FULL") {
    const remaining = admission.remainingSpots ?? 0;
    throw new PublicRegistrationError(
      "EVENT_FULL",
      `Only ${remaining} attendee spot${remaining === 1 ? "" : "s"} remain for this event, and its waitlist is not enabled.`,
    );
  }
  const isWaitlisted = admission.capacityDecision === "WAITLIST";
  const reservations = isWaitlisted
    ? []
    : await tx.registrationCapacityReservation.findMany({
        where: { formId: form.id, releasedAt: null },
        select: { fieldId: true, optionValue: true, rank: true },
      });
  const usage = usageFromReservations(definition, reservations);
  const deferredPaymentFieldKey = isWaitlisted && definition.payment?.enabled
    ? definition.payment.paymentMethodFieldKey
    : null;
  const canonicalInput = deferredPaymentFieldKey
    ? {
        ...input,
        responses: Object.fromEntries(
          Object.entries(input.responses).filter(
            ([key]) => key !== deferredPaymentFieldKey,
          ),
        ),
      }
    : input;
  const prepared = preparePublicRegistration(definition, canonicalInput, {
    timeZone: form.event.timezone,
    now,
    usage,
    ignoreAvailability: isWaitlisted,
    ignoredFieldKeys: deferredPaymentFieldKey
      ? [deferredPaymentFieldKey]
      : undefined,
  });
  if (!prepared.isValid || !prepared.identity) {
    const capacityIssue = prepared.issues.some((issue) => issue.message.includes("reached its limit"));
    throw new PublicRegistrationError(
      capacityIssue ? "CAPACITY_REACHED" : "INVALID_SUBMISSION",
      capacityIssue ? "One of your selections just became full. Review the highlighted choice and submit again." : "Review the highlighted fields and submit again.",
      prepared.issues,
    );
  }

  const configuredPromoField = promoCodeField(definition);
  const submittedPromoCode = configuredPromoField
    && typeof prepared.registrationResponses[configuredPromoField.key]
      === "string"
    ? String(
        prepared.registrationResponses[configuredPromoField.key],
      ).trim()
    : "";
  let claimedPromo: ClaimedPromoCode | null = null;
  let pricedCalculation: FormCalculation & {
    preDiscountSubtotalCents?: number;
    discountAmountCents?: number;
    promoCode?: string;
  } = prepared.calculation;
  if (submittedPromoCode && configuredPromoField) {
    try {
      claimedPromo = await claimPromoCode(tx, {
        eventId: form.eventId,
        submittedCode: submittedPromoCode,
        eligibleSubtotalCents: prepared.calculation.subtotalCents,
        pricingDate: prepared.pricingDate,
        fieldId: configuredPromoField.id,
      });
      pricedCalculation = applyPromoCodeToCalculation(
        definition,
        prepared.registrationResponses,
        prepared.calculation,
        claimedPromo.evaluation,
      );
    } catch (error) {
      if (!(error instanceof PublicPromoCodeError)) throw error;
      throw new PublicRegistrationError(
        "INVALID_SUBMISSION",
        "Review the promo code and submit again.",
        [{
          kind: "validation",
          code: "PROMO_CODE_INVALID",
          fieldId: error.fieldId,
          key: configuredPromoField.key,
          path: `responses.${configuredPromoField.key}`,
          attendeeIndex: null,
          message: error.message,
        }],
      );
    }
  }

  const admittedCalculation: FormCalculation & {
    preDiscountSubtotalCents?: number;
    discountAmountCents?: number;
    promoCode?: string;
  } = isWaitlisted
    ? {
        ...pricedCalculation,
        processingFeeCents: 0,
        totalCents: pricedCalculation.subtotalCents,
      }
    : pricedCalculation;

  const identity: PublicContactIdentity = prepared.identity;
  const accountHolder = await tx.person.upsert({
    where: { normalizedEmail: identity.email },
    update: {},
    create: {
      firstName: identity.firstName,
      lastName: identity.lastName,
      normalizedEmail: identity.email,
      phone: identity.phone || null,
    },
  });
  const confirmationCode = `REG-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const registration = await tx.registration.create({
    data: {
      eventId: form.eventId,
      accountHolderPersonId: accountHolder.id,
      confirmationCode,
      status: isWaitlisted ? "WAITLISTED" : "SUBMITTED",
      totalAmount: admittedCalculation.totalCents / 100,
      contactSnapshot: {
        firstName: identity.firstName,
        lastName: identity.lastName,
        email: identity.email,
        phone: identity.phone,
      },
      submittedAt: now,
    },
  });
  if (claimedPromo) {
    await recordPromoCodeRedemption(tx, {
      eventId: form.eventId,
      registrationId: registration.id,
      claimed: claimedPromo,
    });
  }
  const access = await issueRegistrationAccessToken(tx, {
    registrationId: registration.id,
    now,
  });
  const usedPersonIds = new Set<string>();
  const createdAttendees: Array<{
    attendeeId: string;
    attendeeType: string;
    responses: Record<string, unknown>;
    identity: NonNullable<PreparedPublicAttendee["identity"]>;
  }> = [];
  for (const [position, attendee] of prepared.attendees.entries()) {
    if (!attendee.identity) {
      throw new PublicRegistrationError("INVALID_SUBMISSION", "Every attendee needs a valid name.", prepared.issues);
    }
    const attendeePerson = await resolveAttendeePerson(tx, attendee.identity, accountHolder, usedPersonIds);
    const type = attendeeType({ ...prepared.registrationResponses, ...attendee.responses });
    const created = await tx.registrationAttendee.create({
      data: {
        eventId: form.eventId,
        registrationId: registration.id,
        personId: attendeePerson.id,
        attendeeType: type,
        position,
        profileSnapshot: {
          firstName: attendee.identity.firstName,
          lastName: attendee.identity.lastName,
          email: attendee.identity.email,
          phone: attendee.identity.phone || null,
          source: "PUBLIC_REGISTRATION",
          formVersionId: version.id,
        },
        formResponses: attendee.responses as Prisma.InputJsonValue,
      },
    });
    createdAttendees.push({
      attendeeId: created.id,
      attendeeType: type,
      responses: attendee.responses,
      identity: attendee.identity,
    });
  }
  const registrationAttendeeType = createdAttendees.length > 0
    && createdAttendees.every((attendee) => attendee.attendeeType === "WORKER")
    ? "WORKER"
    : "ATTENDEE";
  const attendeeNames = createdAttendees.map((attendee) => `${attendee.identity.firstName} ${attendee.identity.lastName}`.trim());
  let waitlistPosition: number | null = null;
  if (isWaitlisted) {
    const highestPosition = await tx.registrationWaitlistEntry.aggregate({
      where: { eventId: form.eventId },
      _max: { position: true },
    });
    waitlistPosition = (highestPosition._max.position ?? 0) + 1;
    await tx.registrationWaitlistEntry.create({
      data: {
        eventId: form.eventId,
        registrationId: registration.id,
        position: waitlistPosition,
        attendeeCount: createdAttendees.length,
      },
    });
  }

  const snapshot: PricingSnapshot = {
    currency: definition.payment?.currency ?? "USD",
    formVersionId: version.id,
    eventTimeZone: form.event.timezone,
    pricingDate: prepared.pricingDate,
    lineItems: admittedCalculation.lineItems,
    preDiscountSubtotalCents:
      admittedCalculation.preDiscountSubtotalCents
      ?? admittedCalculation.subtotalCents,
    discountAmountCents: admittedCalculation.discountAmountCents ?? 0,
    promoCode: admittedCalculation.promoCode ?? null,
    subtotalCents: admittedCalculation.subtotalCents,
    processingFeeCents: admittedCalculation.processingFeeCents,
    totalCents: admittedCalculation.totalCents,
    cardSelected: !isWaitlisted && isCardSelected(definition, prepared.registrationResponses),
    paymentCollected: false,
    attendeeCount: createdAttendees.length,
    attendeeNames,
    registrationStatus: isWaitlisted ? "WAITLISTED" : "SUBMITTED",
    paymentEligible: !isWaitlisted,
    waitlistPosition,
  };
  const attendeeResponseSnapshot = prepared.rosterEnabled
    ? prepared.attendees.map((attendee, position) => ({
        clientId: attendee.clientId,
        position,
        responses: attendee.responses,
        identity: attendee.identity,
      }))
    : [];
  await tx.publicRegistrationSubmission.create({
    data: {
      eventId: form.eventId,
      formVersionId: version.id,
      registrationId: registration.id,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      responses: prepared.responses as Prisma.InputJsonValue,
      attendeeResponses: attendeeResponseSnapshot as Prisma.InputJsonValue,
      pricingSnapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  });

  const choiceReservations = selectedCapacityChoices(definition, prepared.registrationResponses, createdAttendees);
  if (!isWaitlisted && choiceReservations.length > 0) {
    await tx.registrationCapacityReservation.createMany({
      data: choiceReservations.map((reservation) => ({
        eventId: form!.eventId,
        formId: form!.id,
        formVersionId: version.id,
        registrationId: registration.id,
        ...reservation,
      })),
    });
  }
  const submissionCorrelationId = randomUUID();
  const queuedMessages = isWaitlisted
    ? await enqueueWaitlistJoinedMessage(tx, {
        eventId: form.eventId,
        registrationId: registration.id,
        correlationId: submissionCorrelationId,
        transitionKey: `public-registration:${version.id}:${input.idempotencyKey}:waitlisted`,
        recipientEmail: identity.email,
        recipientName: `${identity.firstName} ${identity.lastName}`.trim(),
        waitlistPosition,
        metadata: {
          source: "PUBLIC_REGISTRATION",
          formVersionId: version.id,
          waitlistPosition,
        },
      }).then((queued) => ({
        ...queued,
        registrantMessageIds: queued.messageIds,
      }))
    : await enqueuePublicRegistrationMessages(tx, {
        event: form.event,
        registration: {
          id: registration.id,
          confirmationCode,
          attendeeType: registrationAttendeeType,
        },
        formVersionId: version.id,
        submissionIdempotencyKey: input.idempotencyKey,
        identity,
        definition,
        responses: prepared.responses,
        attendeeResponses: createdAttendees.map((attendee) => attendee.responses),
        calculation: admittedCalculation,
      });
  await tx.auditLog.create({
    data: {
      eventId: form.eventId,
      actorUserId: null,
      action: isWaitlisted ? "PUBLIC_REGISTRATION_WAITLISTED" : "PUBLIC_REGISTRATION_SUBMITTED",
      entityType: "Registration",
      entityId: registration.id,
      correlationId: submissionCorrelationId,
      summary: isWaitlisted
        ? `Public registration ${confirmationCode} joined the waitlist through ${definition.title} version ${version.versionNumber}.`
        : `Public registration ${confirmationCode} submitted through ${definition.title} version ${version.versionNumber}.`,
      metadata: {
        formId: form.id,
        formVersionId: version.id,
        versionNumber: version.versionNumber,
        pricingDate: prepared.pricingDate,
        totalCents: admittedCalculation.totalCents,
        promoCode: admittedCalculation.promoCode ?? null,
        discountAmountCents:
          admittedCalculation.discountAmountCents ?? 0,
        attendeeCount: createdAttendees.length,
        capacityDecision: admission.capacityDecision,
        waitlistPosition,
        paymentEligible: !isWaitlisted,
        paymentCollected: false,
        emailSent: false,
        messageCount: queuedMessages.messageIds.length,
        messageDeliveryMode: queuedMessages.deliveryMode,
      },
    },
  });

  return {
    confirmation: {
      ...confirmationFromSnapshot(
        definition,
        confirmationCode,
        identity.email,
        snapshot,
        queuedMessages.deliveryMode === "DISABLED" ? "DISABLED" : "PENDING",
        isWaitlisted ? "WAITLISTED" : "SUBMITTED",
        waitlistPosition,
      ),
      managePath: access.managePath,
      manageLinkExpiresAt: access.expiresAt.toISOString(),
    },
    pendingMessageIds: queuedMessages.pendingMessageIds,
    registrantMessageIds: queuedMessages.registrantMessageIds,
  };
}

function retryableTransactionError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || error.code === "P2002")
  ) || (
    error instanceof PromoCodeOperationError
    && error.code === "PROMO_CODE_CLAIM_CONFLICT"
  );
}

export async function submitPublicRegistration(
  eventSlug: string,
  formSlug: string,
  input: PublicRegistrationInput,
  now = new Date(),
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await prisma.$transaction(
        (tx) => createPublicRegistrationTransaction(tx, eventSlug, formSlug, input, now),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      let processed = {
        capturedIds: [] as string[],
        sentIds: [] as string[],
        failedIds: [] as string[],
        rescheduledIds: [] as string[],
        skippedIds: [] as string[],
      };
      try {
        processed = await processQueuedMessageIdsAfterCommit(
          result.pendingMessageIds,
        );
      } catch (error) {
        console.error(
          "Confirmation processing failed after registration commit",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
      const registrantSent = result.registrantMessageIds.some((messageId) => (
        processed.sentIds.includes(messageId)
      ));
      const registrantCaptured = result.registrantMessageIds.some((messageId) => (
        processed.capturedIds.includes(messageId)
      ));
      const registrantFailed = result.registrantMessageIds.some((messageId) => (
        processed.failedIds.includes(messageId)
      ));
      return {
        ...result.confirmation,
        emailSent: registrantSent,
        notificationStatus: registrantCaptured
          ? "CAPTURED" as const
          : registrantSent
            ? "SENT" as const
            : registrantFailed
              ? "FAILED" as const
              : result.confirmation.notificationStatus,
      };
    } catch (error) {
      if (!retryableTransactionError(error)) throw error;
    }
  }
  throw new PublicRegistrationError("SUBMISSION_CONFLICT", "Another registration changed availability at the same time. Review the form and submit again.");
}
