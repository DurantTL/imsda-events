import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { enqueueRegistrationUpdatedMessage } from "@/modules/communications/transactional-messages";
import {
  getAvailabilityMode,
  isChoiceFieldType,
  isFieldVisible,
  registrationFormDefinitionSchema,
  summarizeChoiceUsage,
  type FormCalculation,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import {
  preparePublicRegistration,
  type PreparedPublicAttendee,
  type PublicRegistrationInput,
  type PublicRegistrationIssue,
} from "@/modules/forms/public-domain";
import {
  applyPromoCodeToCalculation,
  type PromoCodeEvaluation,
} from "@/modules/promo-codes/domain";
import { registrationOperationFingerprint } from "@/modules/registrations/operations-domain";
import { getRegistrationByIdWithClient } from "@/modules/registrations/repository";
import type { RegistrationAmendmentInput } from "@/modules/registrations/schemas";

type AmendmentActor = {
  id: string;
  displayName: string;
};

type AmendmentInputAttendee = RegistrationAmendmentInput["attendees"][number];

export type RegistrationAmendmentErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "REGISTRATION_NOT_ACTIVE"
  | "PUBLIC_FORM_REQUIRED"
  | "REGISTRATION_CHANGED"
  | "INVALID_AMENDMENT"
  | "PROTECTED_FIELD_CHANGED"
  | "ATTENDEE_NOT_FOUND"
  | "ATTENDEE_IDENTITY_CHANGED"
  | "ATTENDEE_HAS_HISTORY"
  | "EVENT_CAPACITY_UNAVAILABLE"
  | "PAYMENT_ADJUSTMENT_REQUIRED"
  | "QUOTE_CHANGED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "AMENDMENT_CONFLICT";

export class RegistrationAmendmentError extends Error {
  constructor(
    public readonly code: RegistrationAmendmentErrorCode,
    message: string,
    public readonly issues: PublicRegistrationIssue[] = [],
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RegistrationAmendmentError";
  }
}

const amendmentRegistrationInclude = {
  event: {
    select: {
      id: true,
      name: true,
      timezone: true,
      capacity: true,
    },
  },
  accountHolderPerson: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      normalizedEmail: true,
      phone: true,
    },
  },
  publicFormSubmission: {
    include: {
      formVersion: {
        select: {
          id: true,
          versionNumber: true,
          definition: true,
          form: { select: { id: true, name: true, slug: true } },
        },
      },
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
      checkIns: { select: { id: true } },
      substitutionOperations: { select: { id: true } },
    },
  },
  payments: {
    where: { status: "SUCCEEDED" as const },
    select: {
      amount: true,
      refunds: {
        where: { status: "SUCCEEDED" as const },
        select: { amount: true },
      },
    },
  },
  capacityReservations: {
    where: { releasedAt: null },
    orderBy: { createdAt: "asc" as const },
  },
  promoCodeRedemption: true,
  operations: {
    where: { type: "AMENDMENT" as const },
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: {
      id: true,
      afterSnapshot: true,
      createdAt: true,
    },
  },
} satisfies Prisma.RegistrationInclude;

type AmendmentRegistration = Prisma.RegistrationGetPayload<{
  include: typeof amendmentRegistrationInclude;
}>;

function recordFromJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cents(value: { toString(): string } | number) {
  return Math.round(Number(value) * 100);
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

function hash(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function storedPricingSnapshot(registration: AmendmentRegistration) {
  const latest = recordFromJson(registration.operations[0]?.afterSnapshot);
  const current = recordFromJson(latest.pricingSnapshot);
  return Object.keys(current).length > 0
    ? current
    : recordFromJson(registration.publicFormSubmission?.pricingSnapshot);
}

function storedRegistrationResponses(registration: AmendmentRegistration) {
  const latest = recordFromJson(registration.operations[0]?.afterSnapshot);
  const current = recordFromJson(latest.registrationResponses);
  return Object.keys(current).length > 0
    ? current
    : recordFromJson(registration.publicFormSubmission?.responses);
}

function protectedRegistrationFieldKeys(definition: RegistrationFormDefinition) {
  const keys = new Set<string>([
    "first_name",
    "last_name",
    "email",
    "phone",
    "promo_code",
  ]);
  if (definition.payment?.enabled) {
    keys.add(definition.payment.paymentMethodFieldKey);
  }
  for (const field of definition.sections.flatMap((section) => section.fields)) {
    if (
      field.scope === "REGISTRATION"
      && (
        field.key.startsWith("primary_contact_")
        || field.key.startsWith("contact_first_name")
        || field.key.startsWith("contact_last_name")
        || field.key === "contact_email"
      )
    ) {
      keys.add(field.key);
    }
  }
  return keys;
}

const protectedAttendeeIdentityKeys = new Set([
  "first_name",
  "last_name",
  "full_name",
  "name",
  "attendee_name",
  "guest_name",
]);

function assertProtectedFieldsUnchanged(
  definition: RegistrationFormDefinition,
  priorRegistrationResponses: Record<string, unknown>,
  input: RegistrationAmendmentInput,
  currentAttendees: AmendmentRegistration["attendees"],
) {
  for (const key of protectedRegistrationFieldKeys(definition)) {
    if (
      stableJson(priorRegistrationResponses[key])
      !== stableJson(input.responses[key])
    ) {
      throw new RegistrationAmendmentError(
        "PROTECTED_FIELD_CHANGED",
        key === "promo_code"
          ? "Promo codes cannot be changed through a registration amendment."
          : "Contact and payment destination fields use their dedicated registration actions and cannot be changed here.",
      );
    }
  }
  const currentById = new Map(currentAttendees.map((attendee) => [attendee.id, attendee]));
  for (const attendeeInput of input.attendees) {
    if (!attendeeInput.attendeeId) continue;
    const current = currentById.get(attendeeInput.attendeeId);
    if (!current) {
      throw new RegistrationAmendmentError(
        "ATTENDEE_NOT_FOUND",
        "One of the attendees changed or was removed. Refresh before reviewing this amendment.",
      );
    }
    const responses = recordFromJson(current.formResponses);
    for (const key of protectedAttendeeIdentityKeys) {
      if (stableJson(responses[key]) !== stableJson(attendeeInput.responses[key])) {
        throw new RegistrationAmendmentError(
          "ATTENDEE_IDENTITY_CHANGED",
          `Use Substitute for a name change to ${current.person.firstName} ${current.person.lastName}. Choices and non-name details can be amended here.`,
        );
      }
    }
  }
}

function choiceUsageFromReservations(
  definition: RegistrationFormDefinition,
  reservations: Array<{ fieldId: string; optionValue: string; rank: number | null }>,
) {
  const usage = summarizeChoiceUsage(definition, []);
  const fields = new Map(
    definition.sections
      .flatMap((section) => section.fields)
      .map((field) => [field.id, field]),
  );
  for (const reservation of reservations) {
    const field = fields.get(reservation.fieldId);
    const stats = field ? usage[field.key]?.[reservation.optionValue] : null;
    if (!stats) continue;
    stats.total += 1;
    if (reservation.rank === 0) stats.first += 1;
    if (reservation.rank === 1) stats.second += 1;
  }
  return usage;
}

function attendeeType(responses: Record<string, unknown>) {
  const value = String(responses.attendee_type ?? "").toLowerCase();
  if (value.includes("worker") || value.includes("volunteer")) return "WORKER";
  if (value.includes("child") || value.includes("teen") || value.includes("youth")) return "CHILD";
  return "ATTENDEE";
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
  for (const field of definition.sections.flatMap((section) => section.fields)) {
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
      const options = Array.isArray(value)
        ? value.map(String)
        : typeof value === "string" && value
          ? [value]
          : [];
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
  return selections;
}

function applyStoredPromo(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  calculation: FormCalculation,
  redemption: AmendmentRegistration["promoCodeRedemption"],
) {
  if (!redemption) return calculation;
  const eligibleSubtotalCents = calculation.subtotalCents;
  if (
    redemption.minimumSubtotalCentsSnapshot !== null
    && eligibleSubtotalCents < redemption.minimumSubtotalCentsSnapshot
  ) {
    throw new RegistrationAmendmentError(
      "INVALID_AMENDMENT",
      "This change would make the registration ineligible for its saved promo code. Adjust the choices or handle the discount through Finance.",
    );
  }
  const rawDiscount = redemption.discountTypeSnapshot === "FIXED_CENTS"
    ? redemption.discountValueSnapshot
    : Math.floor(eligibleSubtotalCents * redemption.discountValueSnapshot / 10_000);
  const cappedDiscount = redemption.discountTypeSnapshot === "PERCENT_BPS"
    && redemption.maximumDiscountCentsSnapshot !== null
    ? Math.min(rawDiscount, redemption.maximumDiscountCentsSnapshot)
    : rawDiscount;
  const evaluation: Extract<PromoCodeEvaluation, { valid: true }> = {
    valid: true,
    code: redemption.codeSnapshot,
    normalizedCode: redemption.codeSnapshot,
    eligibleSubtotalCents,
    discountAmountCents: Math.min(
      eligibleSubtotalCents,
      Math.max(0, cappedDiscount),
    ),
  };
  return applyPromoCodeToCalculation(
    definition,
    registrationResponses,
    calculation,
    evaluation,
  );
}

function sameName(
  attendee: NonNullable<PreparedPublicAttendee["identity"]>,
  current: AmendmentRegistration["attendees"][number],
) {
  return attendee.firstName.trim().toLowerCase() === current.person.firstName.trim().toLowerCase()
    && attendee.lastName.trim().toLowerCase() === current.person.lastName.trim().toLowerCase();
}

function samePersonName(
  left: { firstName: string; lastName: string },
  right: { firstName: string; lastName: string },
) {
  return left.firstName.trim().toLowerCase() === right.firstName.trim().toLowerCase()
    && left.lastName.trim().toLowerCase() === right.lastName.trim().toLowerCase();
}

async function resolveNewAttendeePerson(
  tx: Prisma.TransactionClient,
  attendee: NonNullable<PreparedPublicAttendee["identity"]>,
  accountHolder: AmendmentRegistration["accountHolderPerson"],
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
    const existing = await tx.person.findUnique({
      where: { normalizedEmail: attendee.email },
    });
    if (existing && samePersonName(attendee, existing) && !usedPersonIds.has(existing.id)) {
      usedPersonIds.add(existing.id);
      return existing;
    }
  }
  const emailAvailable = attendee.email
    ? !await tx.person.findUnique({
        where: { normalizedEmail: attendee.email },
        select: { id: true },
      })
    : false;
  const created = await tx.person.create({
    data: {
      firstName: attendee.firstName,
      lastName: attendee.lastName,
      normalizedEmail: attendee.email && emailAvailable ? attendee.email : null,
      phone: attendee.phone || null,
    },
  });
  usedPersonIds.add(created.id);
  return created;
}

function paidCents(registration: AmendmentRegistration) {
  return registration.payments.reduce((total, payment) => (
    total
    + cents(payment.amount)
    - payment.refunds.reduce(
      (refundTotal, refund) => refundTotal + cents(refund.amount),
      0,
    )
  ), 0);
}

function amendmentSnapshot(
  registration: AmendmentRegistration,
  registrationResponses: Record<string, unknown>,
  pricingSnapshot: Record<string, unknown>,
) {
  return {
    registration: {
      id: registration.id,
      status: registration.status,
      confirmationCode: registration.confirmationCode,
      totalAmountCents: cents(registration.totalAmount),
      updatedAt: registration.updatedAt.toISOString(),
    },
    registrationResponses,
    attendees: registration.attendees.map((attendee) => ({
      id: attendee.id,
      personId: attendee.personId,
      position: attendee.position,
      attendeeType: attendee.attendeeType,
      profileSnapshot: attendee.profileSnapshot,
      formResponses: attendee.formResponses,
      checkInIds: attendee.checkIns.map((checkIn) => checkIn.id),
      substitutionOperationIds: attendee.substitutionOperations.map((operation) => operation.id),
    })),
    pricingSnapshot,
    activeCapacityReservations: registration.capacityReservations.map((reservation) => ({
      id: reservation.id,
      registrationAttendeeId: reservation.registrationAttendeeId,
      participantKey: reservation.participantKey,
      fieldId: reservation.fieldId,
      fieldKey: reservation.fieldKey,
      optionValue: reservation.optionValue,
      rank: reservation.rank,
    })),
  };
}

type PreparedAmendment = Awaited<ReturnType<typeof prepareAmendment>>;

function visibleResponses(
  definition: RegistrationFormDefinition,
  scope: "REGISTRATION" | "ATTENDEE",
  registrationResponses: Record<string, unknown>,
  responses: Record<string, unknown>,
) {
  const ignoredKeys = scope === "ATTENDEE"
    ? protectedAttendeeIdentityKeys
    : new Set<string>();
  return Object.fromEntries(
    definition.sections
      .flatMap((section) => section.fields)
      .filter((field) => (
        field.scope === scope
        && !ignoredKeys.has(field.key)
        && isFieldVisible(field, { ...registrationResponses, ...responses })
        && Object.hasOwn(responses, field.key)
      ))
      .map((field) => [field.key, responses[field.key]]),
  );
}

function capacitySelections(
  selections: Array<{
    registrationAttendeeId: string | null;
    fieldId: string;
    optionValue: string;
    rank: number | null;
  }>,
) {
  return selections
    .map((selection) => ({
      attendeeId: selection.registrationAttendeeId,
      fieldId: selection.fieldId,
      optionValue: selection.optionValue,
      rank: selection.rank,
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function hasMeaningfulAttendeeVisibleChange(
  prepared: PreparedAmendment,
  input: RegistrationAmendmentInput,
) {
  const currentRegistrationResponses = visibleResponses(
    prepared.definition,
    "REGISTRATION",
    prepared.currentRegistrationResponses,
    prepared.currentRegistrationResponses,
  );
  const nextRegistrationResponses = visibleResponses(
    prepared.definition,
    "REGISTRATION",
    prepared.prepared.registrationResponses,
    prepared.prepared.registrationResponses,
  );
  const currentAttendees = prepared.registration.attendees.map((attendee) => ({
    attendeeId: attendee.id,
    responses: visibleResponses(
      prepared.definition,
      "ATTENDEE",
      prepared.currentRegistrationResponses,
      recordFromJson(attendee.formResponses),
    ),
  }));
  const nextAttendees = prepared.prepared.attendees.map((attendee, index) => ({
    attendeeId: input.attendees[index]?.attendeeId ?? null,
    responses: visibleResponses(
      prepared.definition,
      "ATTENDEE",
      prepared.prepared.registrationResponses,
      attendee.responses,
    ),
  }));
  const nextCapacitySelections = selectedCapacityChoices(
    prepared.definition,
    prepared.prepared.registrationResponses,
    prepared.prepared.attendees.map((attendee, index) => ({
      attendeeId: input.attendees[index]?.attendeeId ?? `new-attendee:${index}`,
      responses: attendee.responses,
    })),
  );

  return stableJson({
    registrationResponses: currentRegistrationResponses,
    attendees: currentAttendees,
    capacitySelections: capacitySelections(prepared.registration.capacityReservations),
    totalCents: cents(prepared.registration.totalAmount),
  }) !== stableJson({
    registrationResponses: nextRegistrationResponses,
    attendees: nextAttendees,
    capacitySelections: capacitySelections(nextCapacitySelections),
    totalCents: prepared.pricedCalculation.totalCents,
  });
}

async function loadRegistration(
  tx: Prisma.TransactionClient,
  eventId: string,
  registrationId: string,
) {
  return tx.registration.findFirst({
    where: { id: registrationId, eventId },
    include: amendmentRegistrationInclude,
  });
}

async function prepareAmendment(
  tx: Prisma.TransactionClient,
  eventId: string,
  registrationId: string,
  input: RegistrationAmendmentInput,
) {
  const registration = await loadRegistration(tx, eventId, registrationId);
  if (!registration) {
    throw new RegistrationAmendmentError(
      "REGISTRATION_NOT_FOUND",
      "The registration could not be found for this event.",
    );
  }
  if (registration.status !== "SUBMITTED" && registration.status !== "CONFIRMED") {
    throw new RegistrationAmendmentError(
      "REGISTRATION_NOT_ACTIVE",
      "Only an active submitted or confirmed registration can be amended.",
    );
  }
  if (!registration.publicFormSubmission) {
    throw new RegistrationAmendmentError(
      "PUBLIC_FORM_REQUIRED",
      "This registration was not created through a published form. Use the existing staff attendee controls instead.",
    );
  }
  if (registration.updatedAt.toISOString() !== input.expectedUpdatedAt) {
    throw new RegistrationAmendmentError(
      "REGISTRATION_CHANGED",
      "This registration changed after you opened it. Refresh and review the latest record before continuing.",
    );
  }

  const definition = registrationFormDefinitionSchema.parse(
    registration.publicFormSubmission.formVersion.definition,
  );
  const currentRegistrationResponses = storedRegistrationResponses(registration);
  assertProtectedFieldsUnchanged(
    definition,
    currentRegistrationResponses,
    input,
    registration.attendees,
  );

  const currentById = new Map(
    registration.attendees.map((attendee) => [attendee.id, attendee]),
  );
  const retainedIds = new Set(
    input.attendees.flatMap((attendee) => attendee.attendeeId ? [attendee.attendeeId] : []),
  );
  for (const attendeeId of retainedIds) {
    if (!currentById.has(attendeeId)) {
      throw new RegistrationAmendmentError(
        "ATTENDEE_NOT_FOUND",
        "One of the attendees changed or was removed. Refresh before reviewing this amendment.",
      );
    }
  }
  const removedAttendees = registration.attendees.filter((attendee) => !retainedIds.has(attendee.id));
  const blockedRemoval = removedAttendees.find((attendee) => (
    attendee.checkIns.length > 0 || attendee.substitutionOperations.length > 0
  ));
  if (blockedRemoval) {
    throw new RegistrationAmendmentError(
      "ATTENDEE_HAS_HISTORY",
      `${blockedRemoval.person.firstName} ${blockedRemoval.person.lastName} cannot be removed because check-in or substitution history is attached.`,
    );
  }

  const otherReservations = await tx.registrationCapacityReservation.findMany({
    where: {
      formId: registration.publicFormSubmission.formVersion.form.id,
      registrationId: { not: registration.id },
      releasedAt: null,
    },
    select: { fieldId: true, optionValue: true, rank: true },
  });
  const pricingSnapshot = storedPricingSnapshot(registration);
  const pricingDate = typeof pricingSnapshot.pricingDate === "string"
    ? pricingSnapshot.pricingDate
    : registration.publicFormSubmission.createdAt.toISOString().slice(0, 10);
  const pricingInstant = new Date(`${pricingDate}T18:00:00.000Z`);
  const publicInput: PublicRegistrationInput = {
    versionId: registration.publicFormSubmission.formVersionId,
    idempotencyKey: input.clientRequestId,
    responses: input.responses,
    attendees: input.attendees.map((attendee) => ({
      clientId: attendee.clientId,
      responses: attendee.responses,
    })),
    website: "",
  };
  const prepared = preparePublicRegistration(definition, publicInput, {
    timeZone: registration.event.timezone,
    now: pricingInstant,
    usage: choiceUsageFromReservations(definition, otherReservations),
  });
  if (!prepared.isValid) {
    throw new RegistrationAmendmentError(
      "INVALID_AMENDMENT",
      "Review the highlighted registration and attendee fields.",
      prepared.issues,
    );
  }

  prepared.attendees.forEach((attendee, index) => {
    const inputAttendee = input.attendees[index];
    if (!inputAttendee?.attendeeId || !attendee.identity) return;
    const current = currentById.get(inputAttendee.attendeeId);
    if (current && !sameName(attendee.identity, current)) {
      throw new RegistrationAmendmentError(
        "ATTENDEE_IDENTITY_CHANGED",
        `Use Substitute for a name change to ${current.person.firstName} ${current.person.lastName}.`,
      );
    }
  });

  const occupiedElsewhere = await tx.registrationAttendee.count({
    where: {
      eventId,
      registrationId: { not: registration.id },
      registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
    },
  });
  if (
    registration.event.capacity !== null
    && occupiedElsewhere + prepared.attendees.length > registration.event.capacity
  ) {
    const available = Math.max(registration.event.capacity - occupiedElsewhere, 0);
    throw new RegistrationAmendmentError(
      "EVENT_CAPACITY_UNAVAILABLE",
      `Only ${available} attendee spot${available === 1 ? "" : "s"} are available for this registration.`,
    );
  }

  const pricedCalculation = applyStoredPromo(
    definition,
    prepared.registrationResponses,
    prepared.calculation,
    registration.promoCodeRedemption,
  );
  const netPaidCents = paidCents(registration);
  if (pricedCalculation.totalCents < netPaidCents) {
    throw new RegistrationAmendmentError(
      "PAYMENT_ADJUSTMENT_REQUIRED",
      "This change would lower the registration total below the amount already paid. Record the required refund or adjustment in Finance before completing this amendment.",
      [],
      {
        paidCents: netPaidCents,
        proposedTotalCents: pricedCalculation.totalCents,
      },
    );
  }
  const names = prepared.attendees.map((attendee) => (
    attendee.identity
      ? `${attendee.identity.firstName} ${attendee.identity.lastName}`.trim()
      : "Attendee"
  ));
  const nextPricingSnapshot = {
    ...pricingSnapshot,
    lineItems: pricedCalculation.lineItems,
    preDiscountSubtotalCents:
      "preDiscountSubtotalCents" in pricedCalculation
        ? pricedCalculation.preDiscountSubtotalCents
        : pricedCalculation.subtotalCents,
    discountAmountCents:
      "discountAmountCents" in pricedCalculation
        ? pricedCalculation.discountAmountCents
        : 0,
    promoCode:
      "promoCode" in pricedCalculation
        ? pricedCalculation.promoCode
        : null,
    subtotalCents: pricedCalculation.subtotalCents,
    processingFeeCents: pricedCalculation.processingFeeCents,
    totalCents: pricedCalculation.totalCents,
    attendeeCount: prepared.attendees.length,
    attendeeNames: names,
    amendedAt: new Date().toISOString(),
  };
  const quoteFingerprint = hash({
    eventId,
    registrationId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    responses: prepared.registrationResponses,
    attendees: input.attendees.map((attendee, index) => ({
      attendeeId: attendee.attendeeId,
      responses: prepared.attendees[index]?.responses ?? {},
    })),
    totalCents: pricedCalculation.totalCents,
    activeReservationIds: registration.capacityReservations.map((reservation) => reservation.id).sort(),
  });

  return {
    registration,
    definition,
    prepared,
    pricedCalculation,
    currentRegistrationResponses,
    pricingSnapshot,
    nextPricingSnapshot,
    removedAttendees,
    quoteFingerprint,
    paidCents: netPaidCents,
    addedAttendeeCount: input.attendees.filter((attendee) => !attendee.attendeeId).length,
  };
}

function amendmentPreview(prepared: PreparedAmendment) {
  const previousTotalCents = cents(prepared.registration.totalAmount);
  const totalCents = prepared.pricedCalculation.totalCents;
  return {
    quoteFingerprint: prepared.quoteFingerprint,
    previousTotalCents,
    totalCents,
    deltaCents: totalCents - previousTotalCents,
    paidCents: prepared.paidCents,
    balanceCents: Math.max(totalCents - prepared.paidCents, 0),
    previousAttendeeCount: prepared.registration.attendees.length,
    attendeeCount: prepared.prepared.attendees.length,
    addedAttendeeCount: prepared.addedAttendeeCount,
    removedAttendeeCount: prepared.removedAttendees.length,
    lineItems: prepared.pricedCalculation.lineItems,
    pricingDate: prepared.prepared.pricingDate,
  };
}

export async function previewRegistrationAmendment(
  eventId: string,
  registrationId: string,
  input: RegistrationAmendmentInput,
) {
  return getPrisma().$transaction(async (tx) => (
    amendmentPreview(await prepareAmendment(tx, eventId, registrationId, input))
  ));
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || error.code === "P2002");
}

export async function amendRegistration(
  eventId: string,
  registrationId: string,
  input: RegistrationAmendmentInput,
  actor: AmendmentActor,
  now = new Date(),
) {
  const requestFingerprint = registrationOperationFingerprint({
    eventId,
    registrationId,
    operation: "AMENDMENT",
    payload: {
      expectedUpdatedAt: input.expectedUpdatedAt,
      reason: input.reason,
      responses: input.responses,
      attendees: input.attendees,
    },
  });
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.registrationOperation.findUnique({
          where: {
            eventId_clientRequestId: {
              eventId,
              clientRequestId: input.clientRequestId,
            },
          },
          select: {
            registrationId: true,
            type: true,
            requestFingerprint: true,
            responseSnapshot: true,
          },
        });
        if (existing) {
          if (
            existing.registrationId !== registrationId
            || existing.type !== "AMENDMENT"
            || existing.requestFingerprint !== requestFingerprint
          ) {
            throw new RegistrationAmendmentError(
              "IDEMPOTENCY_KEY_REUSED",
              "That amendment request ID was already used for different changes. Start a new review.",
            );
          }
          return existing.responseSnapshot as unknown as {
            registration: NonNullable<Awaited<ReturnType<typeof getRegistrationByIdWithClient>>>;
            amendment: ReturnType<typeof amendmentPreview> & {
              id: string;
              createdAt: string;
            };
            pendingMessageIds: string[];
          };
        }

        const prepared = await prepareAmendment(tx, eventId, registrationId, input);
        if (input.quoteFingerprint !== prepared.quoteFingerprint) {
          throw new RegistrationAmendmentError(
            "QUOTE_CHANGED",
            "Availability or pricing changed after the review. Review the refreshed amendment quote before confirming.",
            [],
            { preview: amendmentPreview(prepared) },
          );
        }
        const beforeSnapshot = amendmentSnapshot(
          prepared.registration,
          prepared.currentRegistrationResponses,
          prepared.pricingSnapshot,
        );
        const currentById = new Map(
          prepared.registration.attendees.map((attendee) => [attendee.id, attendee]),
        );
        const usedPersonIds = new Set(
          prepared.registration.attendees.map((attendee) => attendee.personId),
        );
        const committedAttendees: Array<{
          attendeeId: string;
          responses: Record<string, unknown>;
        }> = [];

        await tx.registrationCapacityReservation.updateMany({
          where: { registrationId, releasedAt: null },
          data: { releasedAt: now },
        });
        if (prepared.removedAttendees.length > 0) {
          await tx.registrationAttendee.deleteMany({
            where: {
              registrationId,
              id: { in: prepared.removedAttendees.map((attendee) => attendee.id) },
            },
          });
        }

        for (const [position, attendee] of prepared.prepared.attendees.entries()) {
          const inputAttendee: AmendmentInputAttendee = input.attendees[position]!;
          if (!attendee.identity) {
            throw new RegistrationAmendmentError(
              "INVALID_AMENDMENT",
              `Attendee ${position + 1} needs a valid name.`,
            );
          }
          if (inputAttendee.attendeeId) {
            const current = currentById.get(inputAttendee.attendeeId);
            if (!current) {
              throw new RegistrationAmendmentError(
                "ATTENDEE_NOT_FOUND",
                "One of the attendees changed before the amendment committed.",
              );
            }
            await tx.registrationAttendee.update({
              where: { id: current.id },
              data: {
                position,
                attendeeType: attendeeType({
                  ...prepared.prepared.registrationResponses,
                  ...attendee.responses,
                }),
                profileSnapshot: {
                  ...recordFromJson(current.profileSnapshot),
                  firstName: attendee.identity.firstName,
                  lastName: attendee.identity.lastName,
                  email: attendee.identity.email,
                  phone: attendee.identity.phone || null,
                },
                formResponses: attendee.responses as Prisma.InputJsonValue,
              },
            });
            committedAttendees.push({
              attendeeId: current.id,
              responses: attendee.responses,
            });
          } else {
            const person = await resolveNewAttendeePerson(
              tx,
              attendee.identity,
              prepared.registration.accountHolderPerson,
              usedPersonIds,
            );
            const created = await tx.registrationAttendee.create({
              data: {
                eventId,
                registrationId,
                personId: person.id,
                attendeeType: attendeeType({
                  ...prepared.prepared.registrationResponses,
                  ...attendee.responses,
                }),
                position,
                profileSnapshot: {
                  firstName: attendee.identity.firstName,
                  lastName: attendee.identity.lastName,
                  email: attendee.identity.email,
                  phone: attendee.identity.phone || null,
                  source: "PUBLIC_REGISTRATION_AMENDMENT",
                  formVersionId: prepared.registration.publicFormSubmission!.formVersionId,
                },
                formResponses: attendee.responses as Prisma.InputJsonValue,
              },
            });
            committedAttendees.push({
              attendeeId: created.id,
              responses: attendee.responses,
            });
          }
        }

        const selections = selectedCapacityChoices(
          prepared.definition,
          prepared.prepared.registrationResponses,
          committedAttendees,
        );
        for (const selection of selections) {
          await tx.registrationCapacityReservation.upsert({
            where: {
              registrationId_participantKey_fieldId_optionValue: {
                registrationId,
                participantKey: selection.participantKey,
                fieldId: selection.fieldId,
                optionValue: selection.optionValue,
              },
            },
            update: {
              registrationAttendeeId: selection.registrationAttendeeId,
              fieldKey: selection.fieldKey,
              rank: selection.rank,
              releasedAt: null,
            },
            create: {
              eventId,
              formId: prepared.registration.publicFormSubmission!.formVersion.form.id,
              formVersionId: prepared.registration.publicFormSubmission!.formVersionId,
              registrationId,
              ...selection,
            },
          });
        }

        await tx.registration.update({
          where: { id: registrationId },
          data: { totalAmount: prepared.pricedCalculation.totalCents / 100 },
        });
        if (prepared.registration.promoCodeRedemption) {
          const discountAmountCents = typeof (
            prepared.pricedCalculation as FormCalculation & {
              discountAmountCents?: number;
            }
          ).discountAmountCents === "number"
            ? (
                prepared.pricedCalculation as FormCalculation & {
                  discountAmountCents: number;
                }
              ).discountAmountCents
            : 0;
          await tx.promoCodeRedemption.update({
            where: { registrationId },
            data: {
              eligibleSubtotalCents: prepared.pricedCalculation.subtotalCents
                + discountAmountCents,
              discountAmountCents,
            },
          });
        }

        const amendmentId = randomUUID();
        const afterReload = await loadRegistration(tx, eventId, registrationId);
        if (!afterReload) {
          throw new RegistrationAmendmentError(
            "AMENDMENT_CONFLICT",
            "The amended registration could not be reloaded safely.",
          );
        }
        const afterSnapshot = amendmentSnapshot(
          afterReload,
          prepared.prepared.registrationResponses,
          {
            ...prepared.nextPricingSnapshot,
            amendedAt: now.toISOString(),
          },
        );
        const serializedBeforeOperation = await getRegistrationByIdWithClient(
          tx,
          eventId,
          registrationId,
        );
        if (!serializedBeforeOperation) {
          throw new RegistrationAmendmentError(
            "AMENDMENT_CONFLICT",
            "The amended registration could not be serialized safely.",
          );
        }
        const registrationRecord = {
          ...serializedBeforeOperation,
          publicSubmission: serializedBeforeOperation.publicSubmission
            ? {
                ...serializedBeforeOperation.publicSubmission,
                responses: prepared.prepared.registrationResponses,
                pricingSnapshot: {
                  ...prepared.nextPricingSnapshot,
                  amendedAt: now.toISOString(),
                },
                amendedAt: now.toISOString(),
                amendmentOperationId: amendmentId,
              }
            : null,
        };
        const response = {
          registration: registrationRecord,
          amendment: {
            id: amendmentId,
            createdAt: now.toISOString(),
            ...amendmentPreview(prepared),
          },
          pendingMessageIds: [] as string[],
        };
        if (hasMeaningfulAttendeeVisibleChange(prepared, input)) {
          const queued = await enqueueRegistrationUpdatedMessage(tx, {
            eventId,
            registrationId,
            correlationId: input.clientRequestId,
            transitionKey: `registration-amendment:${amendmentId}`,
            changeCategory: "REGISTRATION_DETAILS",
          });
          response.pendingMessageIds = queued.pendingMessageIds;
        }
        await tx.registrationOperation.create({
          data: {
            id: amendmentId,
            eventId,
            registrationId,
            type: "AMENDMENT",
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
            action: "REGISTRATION_AMENDED",
            entityType: "RegistrationOperation",
            entityId: amendmentId,
            correlationId: input.clientRequestId,
            summary: `Amended registration ${prepared.registration.confirmationCode}: ${prepared.registration.attendees.length} to ${prepared.prepared.attendees.length} attendees and ${cents(prepared.registration.totalAmount) / 100} to ${prepared.pricedCalculation.totalCents / 100}.`,
            metadata: {
              operationId: amendmentId,
              clientRequestId: input.clientRequestId,
              reason: input.reason,
              priorTotalCents: cents(prepared.registration.totalAmount),
              resultingTotalCents: prepared.pricedCalculation.totalCents,
              priorAttendeeCount: prepared.registration.attendees.length,
              resultingAttendeeCount: prepared.prepared.attendees.length,
              addedAttendeeCount: input.attendees.filter((attendee) => !attendee.attendeeId).length,
              removedAttendeeCount: prepared.removedAttendees.length,
              pricingDate: prepared.prepared.pricingDate,
              originalSubmissionPreserved: true,
            },
          },
        });
        return response;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!retryable(error)) throw error;
    }
  }
  throw new RegistrationAmendmentError(
    "AMENDMENT_CONFLICT",
    "Another action changed this registration at the same time. Refresh, review, and try again.",
  );
}
