import "server-only";

import {
  Prisma,
  RegistrationFormStatus,
  type PrismaClient,
} from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { isLockTimeoutError } from "@/lib/prisma-errors";
import {
  evaluateEventRegistrationPhase,
  registrationClosedMessage,
} from "@/modules/events/lifecycle";
import { calendarDateInTimeZone } from "@/modules/forms/public-domain";
import { hydrateFormOptions } from "@/modules/forms/form-options-repository";
import { lodgingQuoteLine } from "@/modules/lodging/registration-form";
import {
  calculationWithLine,
  getAttendeeRosterConfig,
  registrationFormDefinitionSchema,
  type FormCalculation,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import { preparePublicRegistration } from "@/modules/forms/public-domain";
import {
  applyAttendeePromoCodes,
  applyPromoCodeToCalculation,
  attendeePromoCodeField,
  attendeeShareCents,
  evaluatePromoCode,
  normalizePromoCode,
  promoCodeField,
  type AttendeePromoDiscount,
  type DiscountedFormCalculation,
  type PromoCodeEvaluation,
  type PromoCodeFailureReason,
  type PromoCodeRule,
} from "@/modules/promo-codes/domain";
import { SPONSOR_ORGANIZATION_TYPES, canSponsorClub } from "@/modules/organizations/domain";
import { eventBillsSponsoredPromoCodes } from "@/modules/promo-codes/church-sponsored";
import { isChurchBilledBillingMode, perPersonPrice, type PerPersonPrice } from "@/modules/club-registrations/per-person-price";
import type {
  PromoCodeInput,
  PublicPromoCodeQuoteInput,
  UpdatePromoCodeInput,
} from "@/modules/promo-codes/schemas";

type PromoClient = Prisma.TransactionClient | PrismaClient;

export type PromoCodeOperationErrorCode =
  | "EVENT_NOT_FOUND"
  | "PROMO_CODE_NOT_FOUND"
  | "PROMO_CODE_DUPLICATE"
  | "PROMO_CODE_CONFLICT"
  | "PROMO_CODE_CODE_LOCKED"
  | "PROMO_CODE_LIMIT_BELOW_USAGE"
  | "PROMO_CODE_CLAIM_CONFLICT"
  | "PROMO_CODE_SPONSOR_INVALID"
  | "PROMO_CODE_SPONSOR_LOCKED"
  | "PROMO_CODE_BUSY";

export class PromoCodeOperationError extends Error {
  constructor(
    public readonly code: PromoCodeOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromoCodeOperationError";
  }
}

export class PublicPromoCodeError extends Error {
  constructor(
    public readonly reason:
      | PromoCodeFailureReason
      | "FORM_NOT_FOUND"
      | "REGISTRATION_CLOSED"
      | "FORM_VERSION_CHANGED"
      | "PROMO_FIELD_NOT_CONFIGURED",
    message: string,
    public readonly fieldId: string | null = null,
  ) {
    super(message);
    this.name = "PublicPromoCodeError";
  }
}

type StoredPromo = {
  id: string;
  code: string;
  normalizedCode: string;
  isActive: boolean;
  discountType: "FIXED_CENTS" | "PERCENT_BPS";
  discountValue: number;
  startsOn: string | null;
  endsOn: string | null;
  minimumSubtotalCents: number | null;
  maximumUses: number | null;
  maximumDiscountCents: number | null;
  redeemedCount: number;
  sponsoringOrganizationId: string | null;
};

export type ClaimedPromoCode = {
  promoCode: StoredPromo;
  evaluation: Extract<PromoCodeEvaluation, { valid: true }>;
  pricingDate: string;
};

export type PublicPromoCodeQuote = DiscountedFormCalculation & {
  /** Name of the sponsoring church, shown only for the code the attendee entered (#545). */
  sponsoredBy?: string | null;
};

function storedPromoRule(promo: StoredPromo): PromoCodeRule {
  return promo;
}

function isUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002";
}

function serializePromoCode(
  promo: StoredPromo & {
    createdAt: Date;
    updatedAt: Date;
    sponsoringOrganization?: { name: string } | null;
  },
  pricingDate: string,
) {
  const { sponsoringOrganization, ...stored } = promo;
  const remainingUses = promo.maximumUses === null
    ? null
    : Math.max(promo.maximumUses - promo.redeemedCount, 0);
  const availability = !promo.isActive
    ? "INACTIVE" as const
    : promo.startsOn && pricingDate < promo.startsOn
      ? "UPCOMING" as const
      : promo.endsOn && pricingDate > promo.endsOn
        ? "ENDED" as const
        : remainingUses === 0
          ? "USED_UP" as const
          : "AVAILABLE" as const;
  return {
    ...stored,
    sponsoringOrganizationName: sponsoringOrganization?.name ?? null,
    remainingUses,
    availability,
    createdAt: promo.createdAt.toISOString(),
    updatedAt: promo.updatedAt.toISOString(),
  };
}

export type PromoCodeRecord = ReturnType<typeof serializePromoCode>;

export async function listPromoCodes(eventId: string, now = new Date()) {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { timezone: true },
  });
  if (!event) {
    throw new PromoCodeOperationError(
      "EVENT_NOT_FOUND",
      "The event could not be found.",
    );
  }
  const promos = await prisma.promoCode.findMany({
    where: { eventId },
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
    include: { sponsoringOrganization: { select: { name: true } } },
  });
  const pricingDate = calendarDateInTimeZone(now, event.timezone);
  return promos.map((promo) => serializePromoCode(promo, pricingDate));
}

/**
 * Church-sponsored codes (#545): only a GENERAL, attendee-paid event's code
 * may name a sponsor, and the sponsor must be an active CHURCH organization.
 * An event that bills churches or organizations already invoices them
 * directly (#409), so a sponsored code there would bill it twice. The event
 * row is locked so a concurrent settings change cannot slip past this check
 * (the settings save takes the same lock and refuses to leave the rule while
 * a code has a sponsor).
 */
async function assertSponsorAllowed(
  tx: Prisma.TransactionClient,
  eventId: string,
  sponsoringOrganizationId: string,
) {
  // FOR NO KEY UPDATE serializes this check against an event settings save
  // (which takes the same lock) without conflicting with the FOR KEY SHARE
  // lock every registration or adjustment insert takes on the event, so it
  // can neither deadlock with a claim nor stall registrations. Only the lock
  // wait is bounded; a timeout is reported as "busy, try again".
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR NO KEY UPDATE`;
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
  const event = await tx.event.findUnique({
    where: { id: eventId },
    select: { audience: true, billingMode: true },
  });
  if (!event || !eventBillsSponsoredPromoCodes(event)) {
    throw new PromoCodeOperationError(
      "PROMO_CODE_SPONSOR_INVALID",
      "Only promo codes on general, attendee-paid events can be sponsored by a church. Events that bill churches or organizations already invoice them.",
    );
  }
  const church = await tx.organization.findUnique({
    where: { id: sponsoringOrganizationId },
    select: { type: true, isActive: true },
  });
  if (!canSponsorClub(church)) {
    throw new PromoCodeOperationError(
      "PROMO_CODE_SPONSOR_INVALID",
      "Choose an active church or company as the sponsor.",
    );
  }
}

/** Active churches, companies and groups (#822) staff may pick as a code's sponsor. Names and kind only. */
export async function listSponsorChurchOptions() {
  return getPrisma().organization.findMany({
    where: { type: { in: [...SPONSOR_ORGANIZATION_TYPES] }, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, type: true },
  });
}

/** A lock wait that gave up, or a deadlock / write conflict: nothing was saved, so retrying is safe. */
function busyError(error: unknown) {
  const conflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
  if (!conflict && !isLockTimeoutError(error)) return null;
  return new PromoCodeOperationError(
    "PROMO_CODE_BUSY",
    "The promo codes are busy right now (another change is being saved). Nothing was changed; try again in a moment.",
  );
}

async function auditSponsorChange(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    actorUserId: string;
    promoCodeId: string;
    code: string;
    previous: string | null;
    next: string | null;
  },
) {
  await tx.auditLog.create({
    data: {
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: input.next
        ? "PROMO_CODE_SPONSOR_LINKED"
        : "PROMO_CODE_SPONSOR_UNLINKED",
      entityType: "PromoCode",
      entityId: input.promoCodeId,
      correlationId: crypto.randomUUID(),
      summary: input.next
        ? `Linked promo code ${input.code} to a sponsoring church.`
        : `Removed the sponsoring church from promo code ${input.code}.`,
      // Identifiers only: never a church name or any attendee detail.
      metadata: {
        promoCodeId: input.promoCodeId,
        sponsoringOrganizationId: input.next,
        previousSponsoringOrganizationId: input.previous,
      },
    },
  });
}

export async function createPromoCode(
  eventId: string,
  input: PromoCodeInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  try {
    await prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: eventId },
        select: { id: true },
      });
      if (!event) {
        throw new PromoCodeOperationError(
          "EVENT_NOT_FOUND",
          "The event could not be found.",
        );
      }
      const sponsoringOrganizationId = input.sponsoringOrganizationId ?? null;
      if (sponsoringOrganizationId) {
        await assertSponsorAllowed(tx, eventId, sponsoringOrganizationId);
      }
      const promo = await tx.promoCode.create({
        data: {
          eventId,
          code: input.code,
          normalizedCode: normalizePromoCode(input.code),
          isActive: input.isActive,
          discountType: input.discountType,
          discountValue: input.discountValue,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          minimumSubtotalCents: input.minimumSubtotalCents,
          maximumUses: input.maximumUses,
          maximumDiscountCents: input.maximumDiscountCents,
          sponsoringOrganizationId,
        },
      });
      if (sponsoringOrganizationId) {
        await auditSponsorChange(tx, {
          eventId,
          actorUserId,
          promoCodeId: promo.id,
          code: promo.code,
          previous: null,
          next: sponsoringOrganizationId,
        });
      }
      await tx.auditLog.create({
        data: {
          eventId,
          actorUserId,
          action: "PROMO_CODE_CREATED",
          entityType: "PromoCode",
          entityId: promo.id,
          correlationId: crypto.randomUUID(),
          summary: `Created promo code ${promo.code}.`,
          metadata: {
            discountType: promo.discountType,
            discountValue: promo.discountValue,
            maximumUses: promo.maximumUses,
          },
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new PromoCodeOperationError(
        "PROMO_CODE_DUPLICATE",
        "That promo code is already configured for this event.",
      );
    }
    throw busyError(error) ?? error;
  }
  return listPromoCodes(eventId);
}

export async function updatePromoCode(
  eventId: string,
  promoCodeId: string,
  input: UpdatePromoCodeInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.promoCode.findFirst({
        where: { id: promoCodeId, eventId },
      });
      if (!existing) {
        throw new PromoCodeOperationError(
          "PROMO_CODE_NOT_FOUND",
          "That promo code could not be found for this event.",
        );
      }
      const normalizedCode = normalizePromoCode(input.code);
      if (
        existing.redeemedCount > 0
        && normalizedCode !== existing.normalizedCode
      ) {
        throw new PromoCodeOperationError(
          "PROMO_CODE_CODE_LOCKED",
          "A promo code that has already been used cannot be renamed. Deactivate it and create a new code instead.",
        );
      }
      if (
        input.maximumUses !== null
        && input.maximumUses < existing.redeemedCount
      ) {
        throw new PromoCodeOperationError(
          "PROMO_CODE_LIMIT_BELOW_USAGE",
          `This code has already been used ${existing.redeemedCount} time${existing.redeemedCount === 1 ? "" : "s"}. Its maximum uses cannot be lower than that.`,
        );
      }
      // Omitted means "leave the sponsor as it is".
      const nextSponsor = input.sponsoringOrganizationId === undefined
        ? existing.sponsoringOrganizationId
        : input.sponsoringOrganizationId;
      const sponsorChanged = nextSponsor !== existing.sponsoringOrganizationId;
      if (sponsorChanged) {
        // What a church owes is computed from a code's redemptions, so moving
        // or removing the sponsor of a used code would silently rewrite who
        // owes past discounts. Deactivate it and create a new code instead.
        if (existing.redeemedCount > 0) {
          throw new PromoCodeOperationError(
            "PROMO_CODE_SPONSOR_LOCKED",
            "A promo code that has already been used cannot change its sponsoring church. Deactivate it and create a new code instead.",
          );
        }
        if (nextSponsor) await assertSponsorAllowed(tx, eventId, nextSponsor);
      }
      const changed = await tx.promoCode.updateMany({
        where: {
          id: promoCodeId,
          eventId,
          // Guarded so a use claimed after the read above cannot slip past
          // the sponsor lock.
          ...(sponsorChanged ? { redeemedCount: 0 } : {}),
          updatedAt: new Date(input.expectedUpdatedAt),
        },
        data: {
          sponsoringOrganizationId: nextSponsor,
          code: normalizedCode,
          normalizedCode,
          isActive: input.isActive,
          discountType: input.discountType,
          discountValue: input.discountValue,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          minimumSubtotalCents: input.minimumSubtotalCents,
          maximumUses: input.maximumUses,
          maximumDiscountCents: input.maximumDiscountCents,
        },
      });
      if (changed.count !== 1) {
        throw new PromoCodeOperationError(
          "PROMO_CODE_CONFLICT",
          "Someone else updated this promo code. Refresh and review the latest values before saving.",
        );
      }
      if (sponsorChanged) {
        await auditSponsorChange(tx, {
          eventId,
          actorUserId,
          promoCodeId,
          code: normalizedCode,
          previous: existing.sponsoringOrganizationId,
          next: nextSponsor,
        });
      }
      await tx.auditLog.create({
        data: {
          eventId,
          actorUserId,
          action: input.isActive
            ? "PROMO_CODE_UPDATED"
            : "PROMO_CODE_DEACTIVATED",
          entityType: "PromoCode",
          entityId: promoCodeId,
          correlationId: crypto.randomUUID(),
          summary: input.isActive
            ? `Updated promo code ${normalizedCode}.`
            : `Deactivated promo code ${normalizedCode}.`,
          metadata: {
            previousActive: existing.isActive,
            redeemedCount: existing.redeemedCount,
            discountType: input.discountType,
            discountValue: input.discountValue,
          },
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new PromoCodeOperationError(
        "PROMO_CODE_DUPLICATE",
        "That promo code is already configured for this event.",
      );
    }
    throw busyError(error) ?? error;
  }
  return listPromoCodes(eventId);
}

function publicFormQuery(eventSlug: string, formSlug: string) {
  return {
    where: {
      slug: formSlug,
      event: { slug: eventSlug, isPublished: true },
    },
    select: {
      eventId: true,
      event: {
        select: {
          timezone: true,
          endsAt: true,
          isPublished: true,
          registrationOpensOn: true,
          registrationClosesOn: true,
          waitlistEnabled: true,
          billingMode: true,
          attendeeTypes: {
            where: { isActive: true },
            orderBy: [{ sortOrder: "asc" as const }, { label: "asc" as const }],
          },
        },
      },
      versions: {
        where: { status: RegistrationFormStatus.PUBLISHED },
        orderBy: { versionNumber: "desc" as const },
        take: 1,
        select: {
          id: true,
          definition: true,
        },
      },
    },
  } satisfies Prisma.RegistrationFormFindFirstArgs;
}

function requirePromoField(definition: RegistrationFormDefinition) {
  const field = promoCodeField(definition);
  if (!field) {
    throw new PublicPromoCodeError(
      "PROMO_FIELD_NOT_CONFIGURED",
      "This registration form does not accept promo codes.",
    );
  }
  return field;
}

function publicErrorFromEvaluation(
  evaluation: Exclude<PromoCodeEvaluation, { valid: true }>,
  fieldId: string,
): never {
  throw new PublicPromoCodeError(
    evaluation.reason,
    evaluation.message,
    fieldId,
  );
}

async function findPromoForCode(
  client: PromoClient,
  eventId: string,
  submittedCode: string,
) {
  const normalizedCode = normalizePromoCode(submittedCode);
  return client.promoCode.findUnique({
    where: {
      eventId_normalizedCode: {
        eventId,
        normalizedCode,
      },
    },
  });
}

export type AttendeePromoIssue = {
  attendeeIndex: number;
  fieldId: string;
  key: string;
  path: string;
  message: string;
};

/**
 * Checks every attendee's own promo code (#397): each priced on that person's
 * share, each counted as one use. With `claim`, uses are taken for real (at
 * submission); without, the count is simulated so the form can warn when the
 * same code is entered more times than it has uses left.
 */
export async function evaluateAttendeePromoCodes(
  client: Prisma.TransactionClient | ReturnType<typeof getPrisma>,
  input: {
    eventId: string;
    field: { id: string; key: string };
    attendees: ReadonlyArray<{ responses: Record<string, unknown> }>;
    calculation: FormCalculation;
    pricingDate: string;
    claim: boolean;
    /** Church-billed events: no amounts in any message (#621). */
    hideAmounts?: boolean;
  },
) {
  const discounts: AttendeePromoDiscount[] = [];
  const issues: AttendeePromoIssue[] = [];
  const usedHere = new Map<string, number>();
  for (const [attendeeIndex, attendee] of input.attendees.entries()) {
    const raw = attendee.responses[input.field.key];
    const submittedCode = typeof raw === "string" ? raw.trim() : "";
    if (!submittedCode) continue;
    const issueFor = (message: string) => issues.push({
      attendeeIndex,
      fieldId: input.field.id,
      key: input.field.key,
      path: `attendees.${attendeeIndex}.responses.${input.field.key}`,
      message,
    });
    const eligibleSubtotalCents = attendeeShareCents(input.calculation, attendeeIndex);
    if (input.claim) {
      try {
        const claimed = await claimPromoCode(client as Prisma.TransactionClient, {
          eventId: input.eventId,
          submittedCode,
          eligibleSubtotalCents,
          pricingDate: input.pricingDate,
          fieldId: input.field.id,
          hideAmounts: input.hideAmounts,
        });
        discounts.push({ attendeeIndex, code: claimed.promoCode.code, discountAmountCents: claimed.evaluation.discountAmountCents, promoCodeId: claimed.promoCode.id });
      } catch (error) {
        if (error instanceof PublicPromoCodeError || error instanceof PromoCodeOperationError) {
          issueFor(error.message);
          continue;
        }
        throw error;
      }
      continue;
    }
    const promo = await findPromoForCode(client, input.eventId, submittedCode);
    const earlierUses = promo ? usedHere.get(promo.id) ?? 0 : 0;
    const evaluation = evaluatePromoCode(
      promo ? { ...storedPromoRule(promo), redeemedCount: promo.redeemedCount + earlierUses } : null,
      { submittedCode, eligibleSubtotalCents, pricingDate: input.pricingDate, hideAmounts: input.hideAmounts },
    );
    if (!evaluation.valid) {
      issueFor(
        evaluation.reason === "USE_LIMIT_REACHED" && earlierUses > 0
          ? `${normalizePromoCode(submittedCode)} has no uses left for another person in this registration.`
          : evaluation.message,
      );
      continue;
    }
    usedHere.set(promo!.id, earlierUses + 1);
    discounts.push({ attendeeIndex, code: evaluation.code, discountAmountCents: evaluation.discountAmountCents });
  }
  return { discounts, issues };
}

const hiddenQuoteTotals = [
  "subtotalCents",
  "totalCents",
  "processingFeeCents",
  "preDiscountSubtotalCents",
  "discountAmountCents",
  "lineItems",
] as const;
/**
 * A quote for a church-billed event (#621): no subtotal, total, fee sum, aggregate discount or raw
 * line items (which add back up to the total), only the computed per-person price.
 */
export type ChurchBilledPromoQuote<T> = Omit<T, (typeof hiddenQuoteTotals)[number]> & { perPerson: PerPersonPrice };

function withoutQuoteTotals<T extends DiscountedFormCalculation>(
  quote: T,
  churchBilled: boolean,
  pricing: { roster: boolean; attendeeCount: number },
): T | ChurchBilledPromoQuote<T> {
  if (!churchBilled) return quote;
  const perPerson = perPersonPrice({ lineItems: quote.lineItems, ...pricing });
  const copy: Partial<T> = { ...quote };
  for (const key of hiddenQuoteTotals) delete copy[key];
  return { ...copy, perPerson } as ChurchBilledPromoQuote<T>;
}

/**
 * The calculation a quote starts from: the form's own lines plus the lodging line the submission will add (#199), so a
 * registration-level promo code is worked out on the same subtotal the submission uses (#803): the code discounts the whole
 * subtotal, lodging included, and its minimum is checked against it. A per-person code is limited to that person's lines
 * and never touches the lodging line (it has no attendee). A church-billed event never prices lodging through the
 * registration, so it has no line.
 */
async function quoteCalculation(
  client: PrismaClient,
  eventId: string,
  definition: RegistrationFormDefinition,
  prepared: { registrationResponses: Record<string, unknown>; attendees: unknown[]; calculation: FormCalculation },
  input: PublicPromoCodeQuoteInput,
  churchBilled: boolean,
): Promise<FormCalculation> {
  if (!input.lodging || churchBilled) return prepared.calculation;
  const line = await lodgingQuoteLine(client, eventId, input.lodging, prepared.attendees.length);
  return line ? calculationWithLine(definition, prepared.registrationResponses, prepared.calculation, line.key, line) : prepared.calculation;
}

export type PublicAttendeePromoQuote = DiscountedFormCalculation & {
  /** Sponsoring church name by normalized code, for the codes entered (#545). */
  sponsors?: Record<string, string>;
  attendeeDiscounts: AttendeePromoDiscount[];
  attendeeIssues: AttendeePromoIssue[];
};

export async function getPublicPromoCodeQuote(
  eventSlug: string,
  formSlug: string,
  input: PublicPromoCodeQuoteInput,
  now = new Date(),
): Promise<
  | PublicPromoCodeQuote
  | PublicAttendeePromoQuote
  | ChurchBilledPromoQuote<PublicPromoCodeQuote>
  | ChurchBilledPromoQuote<PublicAttendeePromoQuote>
> {
  const prisma = getPrisma();
  const form = await prisma.registrationForm.findFirst(
    publicFormQuery(eventSlug, formSlug),
  );
  const version = form?.versions[0];
  if (!form || !version) {
    throw new PublicPromoCodeError(
      "FORM_NOT_FOUND",
      "That public registration form is not available.",
    );
  }
  if (evaluateEventRegistrationPhase(form.event, now) === "CLOSED") {
    throw new PublicPromoCodeError(
      "REGISTRATION_CLOSED",
      registrationClosedMessage,
    );
  }
  if (version.id !== input.versionId) {
    throw new PublicPromoCodeError(
      "FORM_VERSION_CHANGED",
      "This form was updated. Refresh the page before applying a promo code.",
    );
  }
  // The same hydration the submit path validates against (#482): attendee
  // types and the live club/church directory.
  const definition = await hydrateFormOptions(
    registrationFormDefinitionSchema.parse(version.definition),
    { attendeeTypes: form.event.attendeeTypes },
  );
  const churchBilled = isChurchBilledBillingMode(form.event.billingMode);
  const attendeeField = attendeePromoCodeField(definition);
  if (attendeeField) {
    // Per person (#397): every attendee's code is checked together; problems
    // come back as warnings on that person rather than failing the quote.
    const prepared = preparePublicRegistration(definition, {
      versionId: input.versionId,
      idempotencyKey: "00000000-0000-4000-8000-000000000000",
      responses: input.responses,
      attendees: input.attendees,
      website: "",
    }, { timeZone: form.event.timezone, now, ignoreAvailability: true });
    const calculation = await quoteCalculation(prisma, form.eventId, definition, prepared, input, churchBilled);
    const { discounts, issues } = await evaluateAttendeePromoCodes(prisma, {
      eventId: form.eventId,
      field: attendeeField,
      attendees: prepared.attendees,
      calculation,
      pricingDate: prepared.pricingDate,
      claim: false,
      hideAmounts: churchBilled,
    });
    const enteredCodes = [...new Set(discounts.map((discount) => normalizePromoCode(discount.code)))];
    const sponsored = enteredCodes.length === 0
      ? []
      : await prisma.promoCode.findMany({
        where: { eventId: form.eventId, normalizedCode: { in: enteredCodes }, sponsoringOrganizationId: { not: null } },
        select: { normalizedCode: true, sponsoringOrganization: { select: { name: true } } },
      });
    return withoutQuoteTotals({
      ...applyAttendeePromoCodes(definition, prepared.registrationResponses, calculation, discounts),
      attendeeIssues: issues,
      sponsors: Object.fromEntries(sponsored.flatMap((promo) =>
        promo.sponsoringOrganization ? [[promo.normalizedCode, promo.sponsoringOrganization.name]] : [])),
    } satisfies PublicAttendeePromoQuote, churchBilled, { roster: true, attendeeCount: prepared.attendees.length });
  }
  const field = requirePromoField(definition);
  const responses = {
    ...input.responses,
    [field.key]: input.code,
  };
  const prepared = preparePublicRegistration(definition, {
    versionId: input.versionId,
    idempotencyKey: "00000000-0000-4000-8000-000000000000",
    responses,
    attendees: input.attendees,
    website: "",
  }, {
    timeZone: form.event.timezone,
    now,
    ignoreAvailability: true,
  });
  const calculation = await quoteCalculation(prisma, form.eventId, definition, prepared, input, churchBilled);
  const promo = await findPromoForCode(
    prisma,
    form.eventId,
    input.code,
  );
  const evaluation = evaluatePromoCode(
    promo ? storedPromoRule(promo) : null,
    {
      submittedCode: input.code,
      eligibleSubtotalCents: calculation.subtotalCents,
      pricingDate: prepared.pricingDate,
      hideAmounts: churchBilled,
    },
  );
  if (!evaluation.valid) publicErrorFromEvaluation(evaluation, field.id);
  const sponsor = promo?.sponsoringOrganizationId
    ? await prisma.organization.findUnique({
      where: { id: promo.sponsoringOrganizationId },
      select: { name: true },
    })
    : null;
  return withoutQuoteTotals({
    ...applyPromoCodeToCalculation(
      definition,
      prepared.registrationResponses,
      calculation,
      evaluation,
    ),
    sponsoredBy: sponsor?.name ?? null,
  }, churchBilled, { roster: getAttendeeRosterConfig(definition).enabled, attendeeCount: prepared.attendees.length });
}

export async function claimPromoCode(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    submittedCode: string;
    eligibleSubtotalCents: number;
    pricingDate: string;
    fieldId: string;
    hideAmounts?: boolean;
  },
): Promise<ClaimedPromoCode> {
  const promo = await findPromoForCode(
    tx,
    input.eventId,
    input.submittedCode,
  );
  const evaluation = evaluatePromoCode(
    promo ? storedPromoRule(promo) : null,
    input,
  );
  if (!evaluation.valid) {
    publicErrorFromEvaluation(evaluation, input.fieldId);
  }

  const claimed = await tx.promoCode.updateMany({
    where: {
      id: promo!.id,
      eventId: input.eventId,
      isActive: true,
      AND: [
        { redeemedCount: promo!.redeemedCount },
        ...(promo!.maximumUses === null
          ? []
          : [{ redeemedCount: { lt: promo!.maximumUses } }]),
      ],
    },
    data: { redeemedCount: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    const current = await findPromoForCode(
      tx,
      input.eventId,
      input.submittedCode,
    );
    const currentEvaluation = evaluatePromoCode(
      current ? storedPromoRule(current) : null,
      input,
    );
    if (!currentEvaluation.valid) {
      publicErrorFromEvaluation(currentEvaluation, input.fieldId);
    }
    throw new PromoCodeOperationError(
      "PROMO_CODE_CLAIM_CONFLICT",
      "Another registration used this promo code at the same time. Please try once more.",
    );
  }
  return { promoCode: promo!, evaluation, pricingDate: input.pricingDate };
}

export async function recordPromoCodeRedemption(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    registrationId: string;
    claimed: ClaimedPromoCode;
  },
) {
  const promo = input.claimed.promoCode;
  const evaluation = input.claimed.evaluation;
  return tx.promoCodeRedemption.create({
    data: {
      eventId: input.eventId,
      promoCodeId: promo.id,
      registrationId: input.registrationId,
      codeSnapshot: promo.code,
      discountTypeSnapshot: promo.discountType,
      discountValueSnapshot: promo.discountValue,
      startsOnSnapshot: promo.startsOn,
      endsOnSnapshot: promo.endsOn,
      minimumSubtotalCentsSnapshot: promo.minimumSubtotalCents,
      maximumUsesSnapshot: promo.maximumUses,
      maximumDiscountCentsSnapshot: promo.maximumDiscountCents,
      eligibleSubtotalCents: evaluation.eligibleSubtotalCents,
      discountAmountCents: evaluation.discountAmountCents,
      pricingDate: input.claimed.pricingDate,
    },
  });
}
