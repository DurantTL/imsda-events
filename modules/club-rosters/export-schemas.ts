import { z } from "zod";
import { ROSTER_EXPORT_COLUMN_KEYS, type RosterExportColumnKey } from "@/modules/club-rosters/export-columns";

const columnKey = z.enum(ROSTER_EXPORT_COLUMN_KEYS as [RosterExportColumnKey, ...RosterExportColumnKey[]]);

const column = z.object({
  key: columnKey,
  header: z.string().trim().min(1, "Give every column a header.").max(60),
});

function noDuplicateKeys(columns: { key: string }[]) {
  const keys = columns.map((entry) => entry.key);
  return new Set(keys).size === keys.length;
}

const columnList = z.array(column)
  .min(1, "Choose at least one column.")
  .max(ROSTER_EXPORT_COLUMN_KEYS.length)
  .refine(noDuplicateKeys, { message: "Choose each column only once." });

/** Building a preview, or the CSV itself: the same shape, so a preview and its download can never drift apart. */
export const rosterExportRequestSchema = z.object({
  mode: z.enum(["preview", "csv"]).default("preview"),
  columns: columnList,
  /** True once the director has seen and accepted the confirmation naming any sensitive columns chosen. */
  confirmSensitive: z.boolean().default(false),
}).strict();

export type RosterExportRequest = z.infer<typeof rosterExportRequestSchema>;

export const rosterExportFormatInputSchema = z.object({
  name: z.string().trim().min(1, "Name the format.").max(80),
  columns: columnList,
}).strict();

export type RosterExportFormatInput = z.infer<typeof rosterExportFormatInputSchema>;
