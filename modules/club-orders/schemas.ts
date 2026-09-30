import { z } from "zod";

/** One helper-list line (#654): the quantity wanted (0 takes it off the list), or null to put it back to the computed count. */
export const clubOrderListQuantitySchema = z.object({
  quantity: z.number().int().min(0).max(10_000).nullable(),
}).strict();

/** Marking a group of needs awarded (#487): up to 500 at once, like the roster's own bulk actions. */
export const clubOrderAwardInputSchema = z.object({
  needIds: z.array(z.string().min(1)).min(1).max(500),
}).strict();

export type ClubOrderAwardInput = z.infer<typeof clubOrderAwardInputSchema>;
