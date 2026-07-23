import { createHash } from "node:crypto";
import { z } from "zod";
import {
  processingFeeForSubtotal,
  registrationFormDefinitionSchema,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";

export const registrationPaymentChoices = ["CARD", "PAY_LATER"] as const;
export type RegistrationPaymentChoice =
  typeof registrationPaymentChoices[number];
const maximumStoredCents = 2_147_483_647;

export const paymentChoiceInputSchema = z.strictObject({
  choice: z.enum(registrationPaymentChoices),
  clientRequestId: z.uuid(),
  expectedPriorOperationId: z.uuid().nullable(),
});

export type PaymentChoiceInput = z.infer<typeof paymentChoiceInputSchema>;

export const paymentChoiceResultSchema = z.strictObject({
  operationId: z.uuid(),
  choice: z.enum(registrationPaymentChoices),
  baseSubtotalCents: z.number().int().safe().nonnegative().max(maximumStoredCents),
  processingFeeCents: z.number().int().safe().nonnegative().max(maximumStoredCents),
  totalCents: z.number().int().safe().nonnegative().max(maximumStoredCents),
  currency: z.literal("USD"),
});

export type PaymentChoiceResult = z.infer<
  typeof paymentChoiceResultSchema
>;

export type PromotedWaitlistPaymentChoiceView = {
  available: boolean;
  locked: boolean;
  selected: RegistrationPaymentChoice | null;
  currentOperationId: string | null;
  baseSubtotalCents: number;
  cardProcessingFeeCents: number;
  cardTotalCents: number;
  payLaterTotalCents: number;
};

const waitlistPricingSnapshotSchema = z.object({
  currency: z.literal("USD"),
  subtotalCents: z.number().int().safe().nonnegative().max(maximumStoredCents),
}).passthrough();

export function paymentConfigurationFromDefinition(
  definitionValue: unknown,
) {
  const parsed = registrationFormDefinitionSchema.safeParse(definitionValue);
  if (!parsed.success || !parsed.data.payment?.enabled) return null;
  return {
    definition: parsed.data,
    payment: parsed.data.payment,
  };
}

export function promotedWaitlistPaymentQuote(
  definitionValue: unknown,
  pricingSnapshotValue: unknown,
) {
  const configuration = paymentConfigurationFromDefinition(definitionValue);
  const pricingSnapshot = waitlistPricingSnapshotSchema.safeParse(
    pricingSnapshotValue,
  );
  if (!configuration || !pricingSnapshot.success) return null;
  const baseSubtotalCents = pricingSnapshot.data.subtotalCents;
  const cardProcessingFeeCents = processingFeeForSubtotal(
    configuration.payment,
    baseSubtotalCents,
    true,
  );
  return {
    baseSubtotalCents,
    cardProcessingFeeCents,
    cardTotalCents: baseSubtotalCents + cardProcessingFeeCents,
    payLaterTotalCents: baseSubtotalCents,
  };
}

export function paymentChoiceQuoteForSelection(
  definition: RegistrationFormDefinition,
  baseSubtotalCents: number,
  choice: RegistrationPaymentChoice,
) {
  const processingFeeCents = choice === "CARD"
    ? processingFeeForSubtotal(definition.payment, baseSubtotalCents, true)
    : 0;
  return {
    baseSubtotalCents,
    processingFeeCents,
    totalCents: baseSubtotalCents + processingFeeCents,
  };
}

export function paymentChoiceRequestFingerprint(
  registrationId: string,
  input: PaymentChoiceInput,
) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    registrationId,
    choice: input.choice,
    clientRequestId: input.clientRequestId,
    expectedPriorOperationId: input.expectedPriorOperationId,
  })).digest("hex");
}
