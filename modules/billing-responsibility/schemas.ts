import { z } from "zod";
import { emailAddressSchema, newPhoneSchema } from "@/lib/field-validation";
import { INVOICE_GROUPINGS } from "@/modules/billing-responsibility/domain";

export const REASON_MAX = 500;

const reasonText = z.string().trim().max(REASON_MAX, `Keep the reason to ${REASON_MAX} characters or fewer.`);
const id = z.string().trim().min(1).max(64);

export const billingContactInputSchema = z.object({
  name: z.string().trim().min(1, "Enter the contact's name.").max(120),
  // A saved billing contact is never edited in place: "set" always writes a new record, so its phone is a new value
  // and has to pass the shared check (#871). The message never carries the number.
  email: emailAddressSchema.refine((value) => value !== "", "Enter the contact's email."),
  phone: newPhoneSchema.optional().transform((value) => value || null),
  roleLabel: z.string().trim().min(1, "Enter a role such as Treasurer.").max(80),
});

export type BillingContactInput = z.infer<typeof billingContactInputSchema>;

/** One endpoint, one tagged body: every action is a MANAGE_FINANCE action on the event in the URL. Billing contacts are not here: they are conference-wide. */
export const billingResponsibilityActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resolve"), apply: z.boolean().default(false) }),
  z.object({ action: z.literal("set-grouping"), invoiceGrouping: z.enum(INVOICE_GROUPINGS as unknown as [string, ...string[]]) }),
  z.object({ action: z.literal("link"), registrationId: id, organizationId: id, reason: reasonText.optional() }),
  z.object({ action: z.literal("clear-override"), registrationId: id, reason: reasonText.optional() }),
]);

/** Conference-level billing contact changes (system administrators only). */
export const billingContactActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), contact: billingContactInputSchema }),
  z.object({ action: z.literal("verify"), contactId: id }),
  z.object({ action: z.literal("end"), contactId: id, reason: reasonText.optional() }),
]);

export type BillingResponsibilityAction = z.infer<typeof billingResponsibilityActionSchema>;
