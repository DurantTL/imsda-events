import { z } from "zod";

/**
 * A reviewer's decision (#491). `confirmedChecksReviewed` is required and
 * discarded rather than stored: it forces the reviewer to affirmatively say
 * they checked the license, insurance, and background-check status
 * elsewhere before the outcome is recorded, without persisting anything
 * about those documents themselves.
 */
export const driverClearanceSchema = z.object({
  clearedToTransport: z.boolean(),
  note: z.string().trim().max(2000).default(""),
  confirmedChecksReviewed: z.literal(true, {
    message: "Confirm that the license, insurance, and background-check status were checked.",
  }),
}).strict();

export type DriverClearanceInput = z.infer<typeof driverClearanceSchema>;
