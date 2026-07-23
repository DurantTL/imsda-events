import "server-only";

import {
  Prisma,
  RegistrationFormStatus,
  type PrismaClient,
} from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { calendarDateInTimeZone } from "@/modules/forms/public-domain";
import {
  registrationFormDefinitionSchema,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import { preparePublicRegistration } from "@/modules/forms/public-domain";
import {
  applyPromoCodeToCalculation,
  evaluatePromoCode,
  normalizePromoCode,
  promoCodeField,
  type DiscountedFormCalculation,
  type PromoCodeEvaluation,
  type PromoCodeFailureReason,
  type PromoCodeRule,
} from "@/modules/promo-codes/domain";
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
  | "PROMO_CODE_CLAIM_CONFLICT";

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
};

export type ClaimedPromoCode = {
  promoCode: StoredPromo;
  evaluation: Extract<PromoCodeEvaluation, { valid: true }>;
  pricingDate: string;
};

export type PublicPromoCodeQuote = DiscountedFormCalculation;

function storedPromoRule(promo: StoredPromo): PromoCodeRule {
  return promo;
}

function isUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002";
}

function serializePromoCode(
  promo: StoredPromo & { createdAt: Date; updatedAt: Date },
  pricingDate: string,
) {
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
    ...promo,
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
  });
  const pricingDate = calendarDateInTimeZone(now, event.timezone);
  return promos.map((promo) => serializePromoCode(promo, pricingDate));
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
        },
      });
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
    throw error;
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
      const changed = await tx.promoCode.updateMany({
        where: {
          id: promoCodeId,
          eventId,
          updatedAt: new Date(input.expectedUpdatedAt),
        },
        data: {
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
    throw error;
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

export async function getPublicPromoCodeQuote(
  eventSlug: string,
  formSlug: string,
  input: PublicPromoCodeQuoteInput,
  now = new Date(),
): Promise<PublicPromoCodeQuote> {
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
  if (version.id !== input.versionId) {
    throw new PublicPromoCodeError(
      "FORM_VERSION_CHANGED",
      "This form was updated. Refresh the page before applying a promo code.",
    );
  }
  const definition = registrationFormDefinitionSchema.parse(
    version.definition,
  );
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
  const promo = await findPromoForCode(
    prisma,
    form.eventId,
    input.code,
  );
  const evaluation = evaluatePromoCode(
    promo ? storedPromoRule(promo) : null,
    {
      submittedCode: input.code,
      eligibleSubtotalCents: prepared.calculation.subtotalCents,
      pricingDate: prepared.pricingDate,
    },
  );
  if (!evaluation.valid) publicErrorFromEvaluation(evaluation, field.id);
  return applyPromoCodeToCalculation(
    definition,
    prepared.registrationResponses,
    prepared.calculation,
    evaluation,
  );
}

export async function claimPromoCode(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    submittedCode: string;
    eligibleSubtotalCents: number;
    pricingDate: string;
    fieldId: string;
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
