import { z } from "zod";

/**
 * The receiving club's director starts a transfer while enrolling the
 * member: they pick an existing roster row at another club
 * (`fromRosterMemberId`, found through the search endpoint) and record why.
 * Roster fields (attendee type, role, class, gender, willing-to-drive) and
 * the sealed birth date come from the sending club's own roster row — they
 * are not retyped, so nothing about the move can quietly drift from what the
 * sending club already had on file.
 */
export const initiateTransferSchema = z.object({
  fromOrganizationId: z.string().min(1, "Choose the member's current club."),
  fromRosterMemberId: z.string().min(1, "Choose who is transferring."),
  reason: z.string().trim().min(1, "Enter a reason for the transfer.").max(500),
}).strict();

export type InitiateTransferInput = z.infer<typeof initiateTransferSchema>;

/** The sending club's acknowledgment: a confirmation, nothing else to type. */
export const acknowledgeTransferSchema = z.object({
  confirm: z.literal(true, "Confirm the transfer."),
}).strict();

/** Conference staff finishing or overriding a transfer records a short note. */
export const staffResolveTransferSchema = z.object({
  note: z.string().trim().max(500).default(""),
}).strict();

export type StaffResolveTransferInput = z.infer<typeof staffResolveTransferSchema>;

export const transferSearchQuerySchema = z.object({
  q: z.string().trim().min(2, "Enter at least 2 characters.").max(80),
});
