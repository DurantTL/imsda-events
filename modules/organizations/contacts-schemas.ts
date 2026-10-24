import { z } from "zod";
import { emailAddressSchema, MAX_PHONE_LENGTH, PHONE_FIELD_MESSAGE } from "@/lib/field-validation";

const id = z.string().trim().min(1).max(64);

/** A church's pastor contact (#977). Name is required; email and phone are optional but validated when given. */
export const pastorContactInputSchema = z.object({
  name: z.string().trim().min(1, "Enter the pastor's name.").max(120),
  // The shared email check, lower-cased; blank is none. A new pastor is always typed fresh, so there is no stored email to keep.
  email: emailAddressSchema.optional().transform((value) => value || null),
  // Left as typed: `setPastorContact` judges it against the stored contact with `resolvePhoneChange` (#1193), so an old saved
  // phone is kept exactly as stored and a changed one is checked and stored normalised.
  phone: z.string().trim().max(MAX_PHONE_LENGTH, PHONE_FIELD_MESSAGE).optional().transform((value) => value || null),
});

export type PastorContactInput = z.infer<typeof pastorContactInputSchema>;

export const organizationContactActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), contact: pastorContactInputSchema }),
  z.object({ action: z.literal("end"), contactId: id, reason: z.string().trim().max(500).optional() }),
]);
