import { z } from "zod";
import { VOID_REASON_MAX, VOID_REASON_MIN } from "@/modules/honors/member-honor-domain";

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

/** Voiding one honor entry (#591): a reason is always required. */
export const voidMemberHonorEntrySchema = z.object({
  reason: z.string().trim()
    .min(VOID_REASON_MIN, `Give a reason of at least ${VOID_REASON_MIN} characters.`)
    .max(VOID_REASON_MAX, `Keep the reason to ${VOID_REASON_MAX} characters or fewer.`),
}).strict();

export type VoidMemberHonorEntryInput = z.infer<typeof voidMemberHonorEntrySchema>;
