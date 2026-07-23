import type {
  FormCalculation,
  RegistrationFormDefinition,
  RegistrationFormField,
} from "@/modules/forms/definition";

export type PromoDiscountKind = "FIXED_CENTS" | "PERCENT_BPS";

export type PromoCodeRule = {
  id: string;
  code: string;
  normalizedCode: string;
  isActive: boolean;
  discountType: PromoDiscountKind;
  discountValue: number;
  startsOn: string | null;
  endsOn: string | null;
  minimumSubtotalCents: number | null;
  maximumUses: number | null;
  maximumDiscountCents: number | null;
  redeemedCount: number;
};

export type PromoCodeFailureReason =
  | "INVALID_FORMAT"
  | "NOT_FOUND"
  | "INACTIVE"
  | "NOT_STARTED"
  | "ENDED"
  | "MINIMUM_NOT_MET"
  | "USE_LIMIT_REACHED"
  | "NO_ELIGIBLE_SUBTOTAL";

export type PromoCodeEvaluation =
  | {
      valid: true;
      code: string;
      normalizedCode: string;
      eligibleSubtotalCents: number;
      discountAmountCents: number;
    }
  | {
      valid: false;
      reason: PromoCodeFailureReason;
      message: string;
    };

export type DiscountedFormCalculation = FormCalculation & {
  preDiscountSubtotalCents: number;
  discountAmountCents: number;
  promoCode: string;
};

const normalizedCodePattern = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function normalizePromoCode(value: string) {
  return value.normalize("NFKC").trim().toUpperCase();
}

export function isNormalizedPromoCode(value: string) {
  return normalizedCodePattern.test(value);
}

export function promoCodeField(
  definition: RegistrationFormDefinition,
): RegistrationFormField | null {
  return definition.sections
    .flatMap((section) => section.fields)
    .find((field) => (
      field.key === "promo_code"
      && field.scope === "REGISTRATION"
      && field.type === "TEXT"
    )) ?? null;
}

export function evaluatePromoCode(
  rule: PromoCodeRule | null,
  input: {
    submittedCode: string;
    eligibleSubtotalCents: number;
    pricingDate: string;
  },
): PromoCodeEvaluation {
  const normalizedCode = normalizePromoCode(input.submittedCode);
  if (!isNormalizedPromoCode(normalizedCode)) {
    return {
      valid: false,
      reason: "INVALID_FORMAT",
      message: "Enter a promo code using 3–32 letters, numbers, hyphens, or underscores.",
    };
  }
  if (!rule || rule.normalizedCode !== normalizedCode) {
    return {
      valid: false,
      reason: "NOT_FOUND",
      message: "That promo code was not recognized. Check the spelling and try again.",
    };
  }
  if (!rule.isActive) {
    return {
      valid: false,
      reason: "INACTIVE",
      message: "That promo code is no longer active.",
    };
  }
  if (rule.startsOn && input.pricingDate < rule.startsOn) {
    return {
      valid: false,
      reason: "NOT_STARTED",
      message: `That promo code can be used starting ${rule.startsOn}.`,
    };
  }
  if (rule.endsOn && input.pricingDate > rule.endsOn) {
    return {
      valid: false,
      reason: "ENDED",
      message: `That promo code ended on ${rule.endsOn}.`,
    };
  }
  if (
    rule.maximumUses !== null
    && rule.redeemedCount >= rule.maximumUses
  ) {
    return {
      valid: false,
      reason: "USE_LIMIT_REACHED",
      message: "That promo code has reached its use limit.",
    };
  }

  const eligibleSubtotalCents = Math.max(
    0,
    Math.round(input.eligibleSubtotalCents),
  );
  if (
    rule.minimumSubtotalCents !== null
    && eligibleSubtotalCents < rule.minimumSubtotalCents
  ) {
    return {
      valid: false,
      reason: "MINIMUM_NOT_MET",
      message: `That promo code requires a subtotal of at least ${money(rule.minimumSubtotalCents)}. Your current subtotal is ${money(eligibleSubtotalCents)}.`,
    };
  }
  if (eligibleSubtotalCents === 0) {
    return {
      valid: false,
      reason: "NO_ELIGIBLE_SUBTOTAL",
      message: "Choose a priced registration option before applying this promo code.",
    };
  }

  const rawDiscount = rule.discountType === "FIXED_CENTS"
    ? rule.discountValue
    : Math.floor(eligibleSubtotalCents * rule.discountValue / 10_000);
  const cappedDiscount = rule.discountType === "PERCENT_BPS"
    && rule.maximumDiscountCents !== null
    ? Math.min(rawDiscount, rule.maximumDiscountCents)
    : rawDiscount;
  const discountAmountCents = Math.min(
    eligibleSubtotalCents,
    Math.max(0, Math.round(cappedDiscount)),
  );

  return {
    valid: true,
    code: rule.code,
    normalizedCode,
    eligibleSubtotalCents,
    discountAmountCents,
  };
}

export function processingFeeForDiscountedSubtotal(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  discountedSubtotalCents: number,
) {
  const payment = definition.payment;
  const cardSelected = Boolean(
    payment?.enabled
    && registrationResponses[payment.paymentMethodFieldKey]
      === payment.cardOptionValue,
  );
  if (
    !payment?.passFeeToRegistrant
    || !cardSelected
    || discountedSubtotalCents <= 0
  ) {
    return 0;
  }
  const rate = payment.percentageBasisPoints / 10_000;
  const grossTotal = Math.ceil(
    (discountedSubtotalCents + payment.fixedFeeCents) / (1 - rate),
  );
  return Math.max(0, grossTotal - discountedSubtotalCents);
}

export function applyPromoCodeToCalculation(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  calculation: FormCalculation,
  evaluation: Extract<PromoCodeEvaluation, { valid: true }>,
): DiscountedFormCalculation {
  const preDiscountSubtotalCents = Math.max(
    0,
    calculation.subtotalCents,
  );
  const discountAmountCents = Math.min(
    preDiscountSubtotalCents,
    Math.max(0, evaluation.discountAmountCents),
  );
  const subtotalCents = Math.max(
    0,
    preDiscountSubtotalCents - discountAmountCents,
  );
  const processingFeeCents = processingFeeForDiscountedSubtotal(
    definition,
    registrationResponses,
    subtotalCents,
  );
  return {
    ...calculation,
    preDiscountSubtotalCents,
    discountAmountCents,
    promoCode: evaluation.code,
    subtotalCents,
    processingFeeCents,
    totalCents: subtotalCents + processingFeeCents,
  };
}

