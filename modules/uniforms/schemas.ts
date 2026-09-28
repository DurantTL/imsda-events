import { z } from "zod";
import { MAX_UNIFORM_ITEMS, MAX_UNIFORM_MEMBERS, MAX_UNIFORM_NEEDS_PER_ENTRY } from "@/modules/uniforms/domain";

/**
 * Recording uniform needs in bulk (#497): "these 12 members each need a scarf
 * and slide" is 12 person ids and 2 catalog item ids (a size is its own
 * catalog item). `alreadyHasOne` is the spreadsheet's "2": the member already
 * has the item, so it is recorded as issued without touching stock.
 */
export const recordUniformNeedsSchema = z
  .object({
    personIds: z.array(z.string().min(1)).min(1).max(MAX_UNIFORM_MEMBERS),
    itemIds: z.array(z.string().min(1)).min(1).max(MAX_UNIFORM_ITEMS),
    alreadyHasOne: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.personIds).size * new Set(value.itemIds).size > MAX_UNIFORM_NEEDS_PER_ENTRY) {
      context.addIssue({ code: "custom", message: `Record at most ${MAX_UNIFORM_NEEDS_PER_ENTRY} needs at a time.` });
    }
  });

export type RecordUniformNeedsInput = z.infer<typeof recordUniformNeedsSchema>;
