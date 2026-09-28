/**
 * Club member transfers (#489): the member moves, and each club's history
 * stays accurate. Pure rules only — no database access — so every screen and
 * the repository agree on the same shape of the flow:
 *
 * - The receiving club's director starts a transfer while enrolling the
 *   member (`initiateTransfer` in the repository creates the receiving
 *   club's roster row right away, so the receiving club can use it).
 * - The sending club's existing roster row stays active until the sending
 *   club acknowledges the move, or conference staff finish or override it —
 *   there is no one-sided silent move.
 * - If the sending club hasn't acknowledged within `ACKNOWLEDGE_WINDOW_DAYS`,
 *   the transfer surfaces in the conference staff queue.
 *
 * The member keeps exactly one `Person`. Only the roster fields and the
 * sealed birth date physically move (a new `ClubRosterMember` row); the
 * year-round honor record already keys off `personId` alone (#486) and needs
 * no change at all. History that belongs to the old club — meeting
 * attendance, filed monthly reports, financial records — is never touched:
 * none of it is keyed to a roster row, only to `organizationId` and dates
 * already in the past.
 */

export const ACKNOWLEDGE_WINDOW_DAYS = 14;

export function acknowledgeDueAt(initiatedAt: Date): Date {
  return new Date(initiatedAt.getTime() + ACKNOWLEDGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export type MemberTransferStatus = "PENDING" | "COMPLETED";
export type MemberTransferResolution = "SENDING_CLUB_ACKNOWLEDGED" | "STAFF_FINISHED" | "STAFF_OVERRIDDEN";

export const memberTransferStatusLabels: Record<MemberTransferStatus, string> = {
  PENDING: "Awaiting acknowledgment",
  COMPLETED: "Completed",
};

export const memberTransferResolutionLabels: Record<MemberTransferResolution, string> = {
  SENDING_CLUB_ACKNOWLEDGED: "Acknowledged by the sending club",
  STAFF_FINISHED: "Finished by conference staff",
  STAFF_OVERRIDDEN: "Overridden by conference staff",
};

/**
 * Whether a still-pending transfer belongs in the conference staff queue:
 * the sending club hasn't acknowledged it within the 14-day window.
 */
export function isOverdueForStaffQueue(
  transfer: { status: MemberTransferStatus; acknowledgeDueAt: Date },
  now: Date,
): boolean {
  return transfer.status === "PENDING" && transfer.acknowledgeDueAt <= now;
}

/** A written reason is required (#489): non-empty after trimming, bounded so it stays a reason, not a report. */
export function transferReasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (!trimmed) return "Enter a reason for the transfer.";
  if (trimmed.length > 500) return "Keep the reason under 500 characters.";
  return null;
}

/** A transfer is only ever within IMSDA, and only ever between two different clubs. */
export function transferOrganizationsProblem(fromOrganizationId: string, toOrganizationId: string): string | null {
  if (fromOrganizationId === toOrganizationId) return "The member is already on this club's roster.";
  return null;
}
