import { z } from "zod";

/** Extras entered per item when placing an order (#487): editable, never negative. */
export const clubOrderBatchInputSchema = z.object({
  extras: z.record(z.string(), z.number().int().min(0).max(10_000)).default({}),
}).strict();

export type ClubOrderBatchInput = z.infer<typeof clubOrderBatchInputSchema>;

/**
 * The extras typed on the order screen, carried on a top-level export link
 * (#487) as repeated `extra=<itemId>:<count>` query parameters, then checked
 * with the very schema that placing the order uses — so the pre-order
 * AdventSource and readable files match the screen exactly. A malformed or
 * repeated item is refused (ZodError, 400), never silently dropped.
 */
const extraParamsSchema = z
  .array(z.string().regex(/^[^:]+:\d+$/, "Each extra must be one item and a whole number, like item:2."))
  .max(500)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const value of values) {
      const itemId = value.slice(0, value.lastIndexOf(":"));
      if (seen.has(itemId)) context.addIssue({ code: "custom", message: "Each item's extras can appear only once." });
      seen.add(itemId);
    }
  });

export function parseExtrasQuery(searchParams: URLSearchParams): ClubOrderBatchInput["extras"] {
  const values = extraParamsSchema.parse(searchParams.getAll("extra"));
  const extras = Object.fromEntries(values.map((value) => {
    const separator = value.lastIndexOf(":");
    return [value.slice(0, separator), Number(value.slice(separator + 1))];
  }));
  return clubOrderBatchInputSchema.parse({ extras }).extras;
}

/** Marking a group of needs awarded (#487): up to 500 at once, like the roster's own bulk actions. */
export const clubOrderAwardInputSchema = z.object({
  needIds: z.array(z.string().min(1)).min(1).max(500),
}).strict();

export type ClubOrderAwardInput = z.infer<typeof clubOrderAwardInputSchema>;
