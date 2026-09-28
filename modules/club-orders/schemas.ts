import { z } from "zod";

/** Extras entered per item when placing an order (#487): editable, never negative. */
export const clubOrderBatchInputSchema = z.object({
  extras: z.record(z.string(), z.number().int().min(0).max(10_000)).default({}),
}).strict();

export type ClubOrderBatchInput = z.infer<typeof clubOrderBatchInputSchema>;

/** Marking a group of received needs as awarded (#487): up to 500 at once, like the roster's own bulk actions. */
export const clubOrderAwardInputSchema = z.object({
  needIds: z.array(z.string().min(1)).min(1).max(500),
}).strict();

export type ClubOrderAwardInput = z.infer<typeof clubOrderAwardInputSchema>;
