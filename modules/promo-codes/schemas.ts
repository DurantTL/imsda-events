import { z } from "zod";
import {
  isNormalizedPromoCode,
  normalizePromoCode,
} from "@/modules/promo-codes/domain";

const calendarDateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "Use a calendar date in YYYY-MM-DD format.",
).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}, "Use a real calendar date.");

const optionalDateSchema = z.union([
  calendarDateSchema,
  z.literal(""),
  z.null(),
]).optional().transform((value) => value || null);

const promoCodeShape = {
  code: z.string().max(80).transform(normalizePromoCode).refine(
    isNormalizedPromoCode,
    "Use 3–32 letters, numbers, hyphens, or underscores.",
  ),
  isActive: z.boolean().default(true),
  discountType: z.enum(["FIXED_CENTS", "PERCENT_BPS"]),
  discountValue: z.number().int().min(1).max(100_000_000),
  startsOn: optionalDateSchema,
  endsOn: optionalDateSchema,
  minimumSubtotalCents: z.number().int().min(0).max(100_000_000).nullable().optional().default(null),
  maximumUses: z.number().int().min(1).max(1_000_000).nullable().optional().default(null),
  maximumDiscountCents: z.number().int().min(1).max(100_000_000).nullable().optional().default(null),
};

function validatePromoCodeInput(
  input: {
    discountType: "FIXED_CENTS" | "PERCENT_BPS";
    discountValue: number;
    startsOn: string | null;
    endsOn: string | null;
    maximumDiscountCents: number | null;
  },
  context: z.RefinementCtx,
) {
  if (input.startsOn && input.endsOn && input.startsOn > input.endsOn) {
    context.addIssue({
      code: "custom",
      path: ["endsOn"],
      message: "The ending date must be on or after the starting date.",
    });
  }
  if (input.discountType === "PERCENT_BPS" && input.discountValue > 10_000) {
    context.addIssue({
      code: "custom",
      path: ["discountValue"],
      message: "A percentage discount cannot exceed 100%.",
    });
  }
  if (
    input.discountType === "FIXED_CENTS"
    && input.maximumDiscountCents !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["maximumDiscountCents"],
      message: "A maximum discount only applies to percentage promo codes.",
    });
  }
}

export const promoCodeInputSchema = z.object(promoCodeShape)
  .strict()
  .superRefine(validatePromoCodeInput);

export const updatePromoCodeInputSchema = z.object({
  ...promoCodeShape,
  expectedUpdatedAt: z.iso.datetime(),
}).strict().superRefine(validatePromoCodeInput);

const quoteAttendeeSchema = z.object({
  clientId: z.string().trim().min(1).max(80),
  responses: z.record(z.string(), z.unknown()),
}).strict();

export const publicPromoCodeQuoteInputSchema = z.object({
  versionId: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(80),
  responses: z.record(z.string(), z.unknown()),
  attendees: z.array(quoteAttendeeSchema).max(50).optional(),
}).strict();

export type PromoCodeInput = z.infer<typeof promoCodeInputSchema>;
export type UpdatePromoCodeInput = z.infer<typeof updatePromoCodeInputSchema>;
export type PublicPromoCodeQuoteInput = z.infer<
  typeof publicPromoCodeQuoteInputSchema
>;
