import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { isSeminarPreferenceField } from "@/modules/attendee-accounts/registration-answer-policy";
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
import { adjustmentTotalCents } from "@/modules/registrations/adjustments";
import { issuesOnChangedAnswers, splitUnconfiguredAnswers } from "@/modules/registrations/amendment-answers";
import { registrationOperationFingerprint } from "@/modules/registrations/operations-domain";
import { getRegistrationByIdWithClient } from "@/modules/registrations/repository";
import { withAttendeeTypeOptions, attendeeTypeSelector } from "@/modules/attendee-types/form-options";
import type { RegistrationAmendmentInput } from "@/modules/registrations/schemas";

/**
 * Who is amending. A staff user amends any registration through the staff
 * UI. A club director (H3b, #366) may only amend their own club's
 * registration, through the club portal, and is recorded on the operation
 * with their attendee account id instead of a staff user id — the two are
 * different id spaces, so `RegistrationOperation.actorUserId` /
 * `actorAttendeeAccountId` are mutually exclusive (enforced by a database
 * check constraint), same shape as `AttendeeAccountPersonLink`'s actor.
 */
export type AmendmentActor =
  | { kind: "STAFF"; id: string; displayName: string }
  | { kind: "CLUB_DIRECTOR"; attendeeAccountId: string; displayName: string }
  /**
   * A system administrator "acting as" a club's director (#442): attributed
   * to their staff user id plus the act-as record, never to an attendee
   * account. The club path gives them exactly a director's rules.
   */
  | { kind: "STAFF_ACTING_DIRECTOR"; id: string; actAsId: string; displayName: string };

function amendmentActorUserId(actor: AmendmentActor) {
  return actor.kind === "CLUB_DIRECTOR" ? null : actor.id;
}

type AmendmentInputAttendee = RegistrationAmendmentInput["attendees"][number];

/**
 * Profile-snapshot markers a trusted server caller may carry onto an amended
 * attendee (club registration, H3b #366), the same markers the original club
 * submission set. Never part of the public amendment schema: the staff route
 * can't set them, and only these keys, with these types, are ever written.
 * Names, contact details, and birth dates are never among them.
 */
export type AmendmentProfileMetadata = {
  clubOrganizationId?: string;
  clubRosterMemberId?: string;
  ageOnEventDate?: number | null;
  temporary?: boolean;
  temporaryAttendeeType?: "ADULT" | "YOUTH";
  clubGuestId?: string;
};

/**
 * Server-only facts about one amended attendee, keyed by the attendee's
 * `clientId` in `AmendmentServerOptions.attendees`. `personId` links a newly
 * added attendee to a known person (a club roster member) instead of
 * matching by name and email; `rosterName` see above; `email` replaces the form-derived email for
 * person matching and the snapshot (a club guest's own email, as the submit
 * path does).
 */
export type AmendmentAttendeeServerOptions = {
  personId?: string;
  email?: string | null;
  profileMetadata?: AmendmentProfileMetadata;
  /**
   * The name of the club roster person this kept attendee is linked to. When
   * set, and only then, the attendee may be renamed, and only to exactly
   * this name: a name corrected on the roster after submitting flows through
   * (the roster is the source of truth), while any other name change is
   * still refused. Staff amendments never set it, so their Substitute rule
   * is unchanged.
   */
  rosterName?: { firstName: string; lastName: string };
};

export type AmendmentServerOptions = {
  attendees?: ReadonlyMap<string, AmendmentAttendeeServerOptions>;
  /**
   * Replaces the fingerprint of the amendment input for replay checks. A
   * caller that builds the amendment from its own request (the club director
   * path) fingerprints that request, so a retry is recognized even after the
   * registration has moved on, and a reused request ID with different content
   * is refused.
   */
  requestFingerprint?: string;
};

function allowedProfileMetadata(metadata: AmendmentProfileMetadata | undefined) {
  if (!metadata) return {};
  const allowed: Record<string, string | number | boolean | null> = {};
  if (typeof metadata.clubOrganizationId === "string") allowed.clubOrganizationId = metadata.clubOrganizationId;
  if (typeof metadata.clubRosterMemberId === "string") allowed.clubRosterMemberId = metadata.clubRosterMemberId;
  if (metadata.ageOnEventDate === null || (typeof metadata.ageOnEventDate === "number" && Number.isInteger(metadata.ageOnEventDate))) {
    allowed.ageOnEventDate = metadata.ageOnEventDate;
  }
  if (typeof metadata.temporary === "boolean") allowed.temporary = metadata.temporary;
  if (metadata.temporaryAttendeeType === "ADULT" || metadata.temporaryAttendeeType === "YOUTH") {
    allowed.temporaryAttendeeType = metadata.temporaryAttendeeType;
  }
  if (typeof metadata.clubGuestId === "string") allowed.clubGuestId = metadata.clubGuestId;
  return allowed;
}

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
      attendeeTypeDefinition: { select: { id: true, code: true, label: true } },
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
  serverOptions: AmendmentServerOptions,
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
    // Per-person promo codes (#397) are money, handled in Finance.
    if (stableJson(responses.promo_code ?? null) !== stableJson(attendeeInput.responses.promo_code ?? null)) {
      throw new RegistrationAmendmentError(
        "PROTECTED_FIELD_CHANGED",
        "Promo codes cannot be changed through a registration amendment. Use Adjust amount owed in Finance.",
      );
    }
    // A roster-linked rename is checked against the roster name once the
    // answers are parsed (see `prepareAmendment`), not refused here.
    if (serverOptions.attendees?.get(attendeeInput.clientId)?.rosterName) continue;
    // The attendee's current name is accepted too: an earlier substitution may
    // have left the prior name in the answers, and this edit corrects it (WR26).
    const currentName: Record<string, string> = {
      first_name: current.person.firstName,
      last_name: current.person.lastName,
    };
    const fullName = `${current.person.firstName} ${current.person.lastName}`.trim();
    for (const key of protectedAttendeeIdentityKeys) {
      const submitted = attendeeInput.responses[key];
      const matchesCurrentName = typeof submitted === "string"
        && Object.hasOwn(responses, key)
        && submitted.trim().toLowerCase() === (currentName[key] ?? fullName).trim().toLowerCase();
      if (!matchesCurrentName && stableJson(responses[key]) !== stableJson(submitted)) {
        throw new RegistrationAmendmentError(
          "ATTENDEE_IDENTITY_CHANGED",
          `Use Substitute for a name change to ${current.person.firstName} ${current.person.lastName}. Choices and non-name details can be amended here.`,
          [],
          { attendeeId: current.id, attendeeName: `${current.person.firstName} ${current.person.lastName}`.trim() },
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

export function resolveAmendmentAttendeeType(
  definition: RegistrationFormDefinition,
  responses: Record<string, unknown>,
  configuredTypes: Array<{ id: string; code: string; label: string }>,
  current: { attendeeType: string; attendeeTypeDefinitionId?: string | null; attendeeTypeDefinition?: { id: string; code: string; label: string } | null } | null,
) {
  const selector = attendeeTypeSelector(definition);
  const selectedCode = selector && typeof responses[selector.key] === "string" ? responses[selector.key] : null;
  const selected = selectedCode ? configuredTypes.find((type) => type.code === selectedCode) : null;
  if (selector && current && current.attendeeTypeDefinition?.code === selectedCode) {
    return { attendeeType: current.attendeeType, attendeeTypeDefinitionId: current.attendeeTypeDefinitionId };
  }
  if (selector && selectedCode && !selected) {
    throw new RegistrationAmendmentError(
      "INVALID_AMENDMENT",
      "A deactivated attendee type can only be retained by the attendee who already has it.",
    );
  }
  if (selector && selected) return { attendeeType: selected.label, attendeeTypeDefinitionId: selected.id };
  return current
    ? { attendeeType: current.attendeeType, attendeeTypeDefinitionId: current.attendeeTypeDefinitionId }
    : { attendeeType: attendeeType(responses), attendeeTypeDefinitionId: null };
}

export function assertAmendmentAttendeeTypeSelections(
  definition: RegistrationFormDefinition,
  attendees: Array<{ attendeeId?: string | null; responses: Record<string, unknown> }>,
  configuredTypes: Array<{ code: string; isActive: boolean }>,
  currentAttendees: Array<{ id: string; attendeeTypeDefinition?: { code: string } | null }>,
) {
  const selectors = definition.sections.flatMap((section) => section.fields)
    .filter((field) => field.optionSource === "ATTENDEE_TYPES");
  const activeCodes = new Set(configuredTypes.filter((type) => type.isActive).map((type) => type.code));
  const currentById = new Map(currentAttendees.map((attendee) => [attendee.id, attendee]));
  for (const attendee of attendees) {
    const current = attendee.attendeeId ? currentById.get(attendee.attendeeId) : null;
    for (const selector of selectors) {
      const selectedValue = attendee.responses[selector.key];
      const selectedCode = typeof selectedValue === "string"
        ? selectedValue
        : null;
      if (selectedCode && !activeCodes.has(selectedCode) && current?.attendeeTypeDefinition?.code !== selectedCode) {
        throw new RegistrationAmendmentError(
          "INVALID_AMENDMENT",
          "A deactivated attendee type can only be retained by the attendee who already has it.",
        );
      }
    }
  }
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

/** Same whole name, however a full-name answer happens to split. */
function sameFullName(
  left: { firstName: string; lastName: string },
  right: { firstName: string; lastName: string },
) {
  const normalized = (name: { firstName: string; lastName: string }) => (
    `${name.firstName} ${name.lastName}`.trim().replace(/\s+/g, " ").toLowerCase()
  );
  return normalized(left) === normalized(right);
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
    totalCents: prepared.finalTotalCents,
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
  serverOptions: AmendmentServerOptions = {},
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

  const configuredTypes = await tx.eventAttendeeType.findMany({
    where: { eventId },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
  });
  const definition = withAttendeeTypeOptions(
    registrationFormDefinitionSchema.parse(registration.publicFormSubmission.formVersion.definition),
    configuredTypes.filter((type) => type.isActive),
  );
  assertAmendmentAttendeeTypeSelections(
    definition,
    input.attendees,
    configuredTypes,
    registration.attendees,
  );
  for (const field of definition.sections.flatMap((section) => section.fields)) {
    if (field.optionSource !== "ATTENDEE_TYPES") continue;
    for (const current of registration.attendees) {
      const code = current.attendeeTypeDefinition?.code;
      if (!code || field.options.includes(code)) continue;
      field.options.push(code);
      field.optionLabels = { ...(field.optionLabels ?? {}), [code]: current.attendeeType };
    }
  }
  const currentRegistrationResponses = storedRegistrationResponses(registration);
  assertProtectedFieldsUnchanged(
    definition,
    currentRegistrationResponses,
    input,
    registration.attendees,
    serverOptions,
  );

  const currentById = new Map(
    registration.attendees.map((attendee) => [attendee.id, attendee]),
  );
  const seminarKeys = definition.sections
    .flatMap((section) => section.fields)
    .filter(isSeminarPreferenceField)
    .map((field) => field.key);
  const seminarPreferencesChanged = input.attendees.some((attendee) => {
    if (!attendee.attendeeId) return false;
    const current = currentById.get(attendee.attendeeId);
    if (!current) return false;
    const currentResponses = recordFromJson(current.formResponses);
    return seminarKeys.some((key) => (
      stableJson(currentResponses[key]) !== stableJson(attendee.responses[key])
    ));
  });
  if (seminarPreferencesChanged && !input.reason.trim()) {
    throw new RegistrationAmendmentError(
      "INVALID_AMENDMENT",
      "Enter a reason for a staff seminar preference override.",
    );
  }
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
      [],
      {
        attendeeId: blockedRemoval.id,
        attendeeName: `${blockedRemoval.person.firstName} ${blockedRemoval.person.lastName}`.trim(),
      },
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
  // Older registrations (imported, or on an earlier form version) may hold
  // answers this form doesn't configure; unchanged ones are carried through
  // untouched instead of failing validation (WR26).
  const configuredKeys = new Set(definition.sections.flatMap((section) => section.fields).map((field) => field.key));
  const storedAttendeeAnswers = input.attendees.map((attendee) => {
    const current = attendee.attendeeId ? currentById.get(attendee.attendeeId) : undefined;
    return current ? recordFromJson(current.formResponses) : null;
  });
  const registrationAnswers = splitUnconfiguredAnswers(configuredKeys, input.responses, currentRegistrationResponses);
  const attendeeAnswers = input.attendees.map((attendee, index) => (
    splitUnconfiguredAnswers(configuredKeys, attendee.responses, storedAttendeeAnswers[index] ?? {})
  ));
  const publicInput: PublicRegistrationInput = {
    versionId: registration.publicFormSubmission.formVersionId,
    idempotencyKey: input.clientRequestId,
    responses: registrationAnswers.answers,
    attendees: input.attendees.map((attendee, index) => ({
      clientId: attendee.clientId,
      responses: attendeeAnswers[index].answers,
    })),
    website: "",
  };
  const prepareOptions = {
    timeZone: registration.event.timezone,
    now: pricingInstant,
    usage: choiceUsageFromReservations(definition, otherReservations),
    // A staff seminar override (with its reason) may clear someone's picks,
    // e.g. a Teen in the Teen program (WR26), even though the question is required.
    optionalFieldKeys: seminarPreferencesChanged ? seminarKeys : [],
  };
  const validated = preparePublicRegistration(definition, publicInput, prepareOptions);
  // The same check on the stored answers, so only issues the registration
  // already had can be excused below.
  const configuredOnly = (answers: Record<string, unknown>) => Object.fromEntries(
    Object.entries(answers).filter(([key]) => configuredKeys.has(key)),
  );
  const baseline = preparePublicRegistration(definition, {
    ...publicInput,
    responses: configuredOnly(currentRegistrationResponses),
    attendees: input.attendees.map((attendee, index) => ({
      clientId: attendee.clientId,
      responses: storedAttendeeAnswers[index] ? configuredOnly(storedAttendeeAnswers[index]) : attendeeAnswers[index].answers,
    })),
  }, prepareOptions);
  // Answers nobody changed aren't re-checked against today's rules, e.g. a
  // Teen with no seminar ranks when staff only fix a shirt size (WR26).
  const changedIssues = issuesOnChangedAnswers(
    validated.issues,
    baseline.issues,
    input.responses,
    currentRegistrationResponses,
    input.attendees.map((attendee, index) => ({ submitted: attendee.responses, stored: storedAttendeeAnswers[index] })),
  );
  if (changedIssues.length > 0) {
    throw new RegistrationAmendmentError(
      "INVALID_AMENDMENT",
      "Review the highlighted registration and attendee fields.",
      changedIssues,
    );
  }
  const prepared = {
    ...validated,
    issues: changedIssues,
    isValid: true,
    registrationResponses: { ...registrationAnswers.preserved, ...validated.registrationResponses },
    attendees: validated.attendees.map((attendee, index) => ({
      ...attendee,
      responses: { ...attendeeAnswers[index]?.preserved, ...attendee.responses },
    })),
  };

  let rosterRenamedCount = 0;
  prepared.attendees.forEach((attendee, index) => {
    const inputAttendee = input.attendees[index];
    if (!inputAttendee?.attendeeId || !attendee.identity) return;
    const current = currentById.get(inputAttendee.attendeeId);
    const rosterName = serverOptions.attendees?.get(inputAttendee.clientId)?.rosterName;
    if (current && rosterName) {
      if (!sameFullName(attendee.identity, rosterName)) {
        throw new RegistrationAmendmentError(
          "ATTENDEE_IDENTITY_CHANGED",
          `Use Substitute for a name change to ${current.person.firstName} ${current.person.lastName}.`,
          [],
          { attendeeId: current.id, attendeeName: `${current.person.firstName} ${current.person.lastName}`.trim() },
        );
      }
      const snapshot = recordFromJson(current.profileSnapshot);
      if (!sameFullName(attendee.identity, {
        firstName: typeof snapshot.firstName === "string" ? snapshot.firstName : "",
        lastName: typeof snapshot.lastName === "string" ? snapshot.lastName : "",
      })) {
        rosterRenamedCount += 1;
      }
      return;
    }
    if (current && !sameName(attendee.identity, current)) {
      throw new RegistrationAmendmentError(
        "ATTENDEE_IDENTITY_CHANGED",
        `Use Substitute for a name change to ${current.person.firstName} ${current.person.lastName}.`,
        [],
        { attendeeId: current.id, attendeeName: `${current.person.firstName} ${current.person.lastName}`.trim() },
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
  // Staff adjustments (#396) stay on top of whatever the new answers cost.
  const adjustmentsCents = await adjustmentTotalCents(tx, registration.id);
  if (Math.max(pricedCalculation.totalCents + adjustmentsCents, 0) < netPaidCents) {
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
    totalCents: Math.max(pricedCalculation.totalCents + adjustmentsCents, 0),
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
    adjustmentsCents,
    finalTotalCents: Math.max(pricedCalculation.totalCents + adjustmentsCents, 0),
    addedAttendeeCount: input.attendees.filter((attendee) => !attendee.attendeeId).length,
    seminarPreferencesChanged,
    configuredTypes,
    rosterRenamedCount,
  };
}

function amendmentPreview(prepared: PreparedAmendment) {
  const previousTotalCents = cents(prepared.registration.totalAmount);
  const totalCents = prepared.finalTotalCents;
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

/**
 * The registration-scope answers an amendment must echo back unchanged to
 * pass `assertProtectedFieldsUnchanged`, and the `updatedAt` an amendment's
 * `expectedUpdatedAt` must match. Same precedence `prepareAmendment` uses
 * internally (the latest amendment's snapshot, falling back to the original
 * submission): a caller that only ever amends attendees, never registration
 * fields, can read this once and pass it straight through. Returns null when
 * the registration can't be amended at all (not found, wrong event, or
 * never submitted through a published form).
 */
export async function currentRegistrationAnswers(eventId: string, registrationId: string) {
  const registration = await getPrisma().registration.findFirst({
    where: { id: registrationId, eventId },
    select: {
      updatedAt: true,
      publicFormSubmission: { select: { responses: true } },
      operations: {
        where: { type: "AMENDMENT" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { afterSnapshot: true },
      },
    },
  });
  if (!registration || !registration.publicFormSubmission) return null;
  const latest = recordFromJson(registration.operations[0]?.afterSnapshot);
  const current = recordFromJson(latest.registrationResponses);
  return {
    updatedAt: registration.updatedAt.toISOString(),
    responses: Object.keys(current).length > 0
      ? current
      : recordFromJson(registration.publicFormSubmission.responses),
  };
}

export async function previewRegistrationAmendment(
  eventId: string,
  registrationId: string,
  input: RegistrationAmendmentInput,
  serverOptions: AmendmentServerOptions = {},
) {
  return getPrisma().$transaction(async (tx) => (
    amendmentPreview(await prepareAmendment(tx, eventId, registrationId, input, serverOptions))
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
  serverOptions: AmendmentServerOptions = {},
) {
  const requestFingerprint = serverOptions.requestFingerprint ?? registrationOperationFingerprint({
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

        const prepared = await prepareAmendment(tx, eventId, registrationId, input, serverOptions);
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
          const attendeeOptions = serverOptions.attendees?.get(inputAttendee.clientId);
          const profileMetadata = allowedProfileMetadata(attendeeOptions?.profileMetadata);
          const identity = attendeeOptions && "email" in attendeeOptions
            ? { ...attendee.identity, email: attendeeOptions.email ?? attendee.identity.email }
            : attendee.identity;
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
                ...resolveAmendmentAttendeeType(
                  prepared.definition,
                  { ...prepared.prepared.registrationResponses, ...attendee.responses },
                  prepared.configuredTypes.filter((type) => type.isActive),
                  current,
                ),
                profileSnapshot: {
                  ...recordFromJson(current.profileSnapshot),
                  // Server-only markers go first, so identity always wins.
                  ...profileMetadata,
                  firstName: identity.firstName,
                  lastName: identity.lastName,
                  email: identity.email,
                  phone: identity.phone || null,
                },
                formResponses: attendee.responses as Prisma.InputJsonValue,
              },
            });
            committedAttendees.push({
              attendeeId: current.id,
              responses: attendee.responses,
            });
          } else {
            // A known person (a club roster member) is linked directly, the
            // same as the club submit path; otherwise match by name/email.
            const person = attendeeOptions?.personId
              ? { id: attendeeOptions.personId }
              : await resolveNewAttendeePerson(
                  tx,
                  identity,
                  prepared.registration.accountHolderPerson,
                  usedPersonIds,
                );
            usedPersonIds.add(person.id);
            const created = await tx.registrationAttendee.create({
              data: {
                eventId,
                registrationId,
                personId: person.id,
                ...resolveAmendmentAttendeeType(
                  prepared.definition,
                  { ...prepared.prepared.registrationResponses, ...attendee.responses },
                  prepared.configuredTypes.filter((type) => type.isActive),
                  null,
                ),
                position,
                profileSnapshot: {
                  // Server-only markers go first, so identity always wins.
                  ...profileMetadata,
                  firstName: identity.firstName,
                  lastName: identity.lastName,
                  email: identity.email,
                  phone: identity.phone || null,
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
          data: { totalAmount: prepared.finalTotalCents / 100 },
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
            changeCategory: prepared.seminarPreferencesChanged
              ? "SEMINAR_PREFERENCES"
              : "REGISTRATION_DETAILS",
            seminarPreferences: prepared.seminarPreferencesChanged
              ? prepared.prepared.attendees.map((attendee) => ({
                  attendeeName: attendee.identity
                    ? `${attendee.identity.firstName} ${attendee.identity.lastName}`.trim()
                    : "Attendee",
                  seminarLabels: prepared.definition.sections
                    .flatMap((section) => section.fields)
                    .filter(isSeminarPreferenceField)
                    .flatMap((field) => {
                      const value = attendee.responses[field.key];
                      return Array.isArray(value)
                        ? value.flatMap((label) => (
                            typeof label === "string" && field.options.includes(label)
                              ? [label]
                              : []
                          ))
                        : [];
                    }),
                }))
              : undefined,
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
            actorUserId: amendmentActorUserId(actor),
            actorAttendeeAccountId: actor.kind === "CLUB_DIRECTOR" ? actor.attendeeAccountId : null,
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
            // A director actor has no staff `User` row for this FK, so it
            // stays null here (same pattern as attendee self-service
            // answer updates); the director's attendee account id is
            // recorded structurally on the operation above and, redundantly
            // for audit queries that only scan AuditLog, in metadata below.
            // Never their name or birth date.
            actorUserId: amendmentActorUserId(actor),
            action: "REGISTRATION_AMENDED",
            entityType: "RegistrationOperation",
            entityId: amendmentId,
            correlationId: input.clientRequestId,
            summary: `Amended registration ${prepared.registration.confirmationCode}: ${prepared.registration.attendees.length} to ${prepared.prepared.attendees.length} attendees and ${cents(prepared.registration.totalAmount) / 100} to ${prepared.finalTotalCents / 100}.`,
            metadata: {
              operationId: amendmentId,
              clientRequestId: input.clientRequestId,
              reason: input.reason,
              actorKind: actor.kind,
              actorAttendeeAccountId: actor.kind === "CLUB_DIRECTOR" ? actor.attendeeAccountId : null,
              ...(actor.kind === "STAFF_ACTING_DIRECTOR" ? { actAsId: actor.actAsId } : {}),
              priorTotalCents: cents(prepared.registration.totalAmount),
              resultingTotalCents: prepared.finalTotalCents,
              priorAttendeeCount: prepared.registration.attendees.length,
              resultingAttendeeCount: prepared.prepared.attendees.length,
              addedAttendeeCount: input.attendees.filter((attendee) => !attendee.attendeeId).length,
              removedAttendeeCount: prepared.removedAttendees.length,
              pricingDate: prepared.prepared.pricingDate,
              originalSubmissionPreserved: true,
              seminarPreferenceOverride: prepared.seminarPreferencesChanged,
              // How many kept people took a corrected club roster name (a
              // count only; names stay out of audit metadata).
              rosterNameUpdatedCount: prepared.rosterRenamedCount,
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
