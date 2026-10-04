import { z } from "zod";
import { RESPONSIBLE_ADULT_REASON_MAX } from "@/modules/guardian-authority/domain";

const id = z.string().trim().min(1).max(64);

/** Every staff change carries a reason. */
const reason = z.string().trim()
  .min(1, "Say why you are changing the responsible adult.")
  .max(RESPONSIBLE_ADULT_REASON_MAX, `Keep the reason to ${RESPONSIBLE_ADULT_REASON_MAX} characters or fewer.`);

/** One endpoint, one tagged body: every action is a MANAGE_REGISTRATION action on the event in the URL. */
export const guardianAuthorityActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("set"), attendeeId: id, adultPersonId: id, reason }),
  z.strictObject({ action: z.literal("revoke"), attendeeId: id, reason }),
  z.strictObject({ action: z.literal("dismiss"), conflictId: id, reason }),
]);

export type GuardianAuthorityAction = z.infer<typeof guardianAuthorityActionSchema>;
