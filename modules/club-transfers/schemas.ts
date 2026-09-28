import { z } from "zod";
import { staffQueueFilters } from "@/modules/club-transfers/domain";

/**
 * The receiving club's director requests a transfer (#489 decision 1): the
 * member's exact first and last name, their current club (from a club
 * picker, never a search of that club's roster), and why. Nothing else is
 * typed: roster fields and the sealed birth date come from the sending
 * club's own row, and only when the transfer completes.
 */
export const requestTransferSchema = z.object({
  fromOrganizationId: z.string().trim().min(1, "Choose the member's current club.").max(64),
  firstName: z.string().trim().min(1, "Enter the member's first name.").max(80),
  lastName: z.string().trim().min(1, "Enter the member's last name.").max(80),
  reason: z.string().trim().min(1, "Enter a reason for the transfer.").max(500, "Keep the reason under 500 characters."),
}).strict();

export type RequestTransferInput = z.infer<typeof requestTransferSchema>;

/** The sending club's acceptance: a confirmation, nothing else to type. */
export const acceptTransferSchema = z.object({
  confirm: z.literal(true, "Confirm the transfer."),
}).strict();

/** A decline or a club cancellation may carry a short note, kept for conference staff (never emailed). */
export const clubNoteSchema = z.object({
  confirm: z.literal(true, "Confirm first."),
  note: z.string().trim().max(500).default(""),
}).strict();

/** Conference staff finishing an overdue transfer may leave a note. */
export const staffFinishTransferSchema = z.object({
  note: z.string().trim().max(500).default(""),
}).strict();

/**
 * Conference staff overriding a transfer must say why (#489 N2). An
 * unmatched request names the sending club's roster row staff chose.
 */
export const staffOverrideTransferSchema = z.object({
  note: z.string().trim().min(1, "Enter a note explaining the override.").max(500),
  fromRosterMemberId: z.string().trim().min(1).max(64).optional(),
}).strict();

export const staffCancelTransferSchema = z.object({
  note: z.string().trim().min(1, "Enter a note explaining why this is closed.").max(500),
}).strict();

export const staffQueueQuerySchema = z.object({
  filter: z.enum(staffQueueFilters).default("open"),
});

export const approveRegistrationMoveSchema = z.object({
  confirm: z.literal(true, "Confirm the move."),
  note: z.string().trim().max(500).default(""),
}).strict();

export const skipRegistrationMoveSchema = z.object({
  note: z.string().trim().max(500).default(""),
}).strict();
