import { z } from "zod";

/**
 * Recording a member's honor (#486). One member (single edit) or many
 * (bulk entry after a meeting) share this shape; the repository fans a bulk
 * request out into one append-only entry per member.
 */
const entryFields = {
  honorId: z.string().min(1, "Choose an honor."),
  status: z.enum(["IN_PROGRESS", "COMPLETED"]),
  completionDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$|^$/, "Enter a real date.").default(""),
  note: z.string().trim().max(500).default(""),
};

export const memberHonorEntrySchema = z.object({
  ...entryFields,
}).strict();

export const bulkMemberHonorEntrySchema = z.object({
  memberIds: z.array(z.string().min(1)).min(1, "Choose at least one person.").max(500),
  ...entryFields,
}).strict();

export type MemberHonorEntryInput = z.infer<typeof memberHonorEntrySchema>;
export type BulkMemberHonorEntryInput = z.infer<typeof bulkMemberHonorEntrySchema>;
