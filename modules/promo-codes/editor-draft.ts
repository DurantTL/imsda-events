import { normalizePromoCode } from "@/modules/promo-codes/domain";

export type PromoCodeEditorDiscountType = "FIXED_CENTS" | "PERCENT_BPS";

export type PromoCodeEditorRecord = {
  code: string;
  isActive: boolean;
  discountType: PromoCodeEditorDiscountType;
  discountValue: number;
  startsOn: string | null;
  endsOn: string | null;
  minimumSubtotalCents: number | null;
  maximumUses: number | null;
  maximumDiscountCents: number | null;
};

export type RawPromoCodeEditorDraft = {
  code: string;
  isActive: boolean;
  discountType: string;
  discountValue: string;
  startsOn: string;
  endsOn: string;
  minimumSubtotal: string;
  maximumUses: string;
  maximumDiscount: string;
};

export type NormalizedPromoCodeEditorDraft = {
  code: string;
  isActive: boolean;
  discountType: PromoCodeEditorDiscountType;
  discountValue: number | null;
  startsOn: string | null;
  endsOn: string | null;
  minimumSubtotalCents: number | null;
  maximumUses: number | null;
  maximumDiscountCents: number | null;
};

function normalizedScaledNumber(value: string, multiplier = 1) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : null;
}

function normalizedDate(value: string) {
  return value.trim() || null;
}

function normalizedDiscountType(value: string): PromoCodeEditorDiscountType {
  return value === "PERCENT_BPS" ? "PERCENT_BPS" : "FIXED_CENTS";
}

export function emptyPromoCodeEditorDraft(): NormalizedPromoCodeEditorDraft {
  return {
    code: "",
    isActive: true,
    discountType: "FIXED_CENTS",
    discountValue: null,
    startsOn: null,
    endsOn: null,
    minimumSubtotalCents: null,
    maximumUses: null,
    maximumDiscountCents: null,
  };
}

export function savedPromoCodeEditorDraft(
  promo: PromoCodeEditorRecord | null,
): NormalizedPromoCodeEditorDraft {
  if (!promo) return emptyPromoCodeEditorDraft();
  return {
    code: normalizePromoCode(promo.code),
    isActive: promo.isActive,
    discountType: promo.discountType,
    discountValue: promo.discountValue,
    startsOn: promo.startsOn,
    endsOn: promo.endsOn,
    minimumSubtotalCents: promo.minimumSubtotalCents,
    maximumUses: promo.maximumUses,
    maximumDiscountCents: promo.discountType === "PERCENT_BPS"
      ? promo.maximumDiscountCents
      : null,
  };
}

export function normalizePromoCodeEditorDraft(
  draft: RawPromoCodeEditorDraft,
): NormalizedPromoCodeEditorDraft {
  const discountType = normalizedDiscountType(draft.discountType);
  return {
    code: normalizePromoCode(draft.code),
    isActive: draft.isActive,
    discountType,
    discountValue: normalizedScaledNumber(draft.discountValue, 100),
    startsOn: normalizedDate(draft.startsOn),
    endsOn: normalizedDate(draft.endsOn),
    minimumSubtotalCents: normalizedScaledNumber(
      draft.minimumSubtotal,
      100,
    ),
    maximumUses: normalizedScaledNumber(draft.maximumUses),
    maximumDiscountCents: discountType === "PERCENT_BPS"
      ? normalizedScaledNumber(draft.maximumDiscount, 100)
      : null,
  };
}

export function isPromoCodeEditorDraftDirty(
  saved: NormalizedPromoCodeEditorDraft,
  current: NormalizedPromoCodeEditorDraft,
) {
  return saved.code !== current.code
    || saved.isActive !== current.isActive
    || saved.discountType !== current.discountType
    || saved.discountValue !== current.discountValue
    || saved.startsOn !== current.startsOn
    || saved.endsOn !== current.endsOn
    || saved.minimumSubtotalCents !== current.minimumSubtotalCents
    || saved.maximumUses !== current.maximumUses
    || saved.maximumDiscountCents !== current.maximumDiscountCents;
}
