import { z } from "zod";

/**
 * A staff override of the automatic driver clearance (#544). It always
 * carries a note saying why (a phone call, say), so the override is never
 * silent. Nothing about a license or insurance is accepted: `.strict()`
 * refuses any field this route was never meant to carry.
 */
export const driverClearanceSchema = z.object({
  clearedToTransport: z.boolean(),
  note: z.string().trim().min(1, "Add a note saying why you are overriding.").max(2000),
}).strict();

export type DriverClearanceInput = z.infer<typeof driverClearanceSchema>;
