/**
 * Club member transfers (#489): the member moves, and each club's history
 * stays accurate. Pure rules only, no database access, so every screen and
 * the repository agree on the same shape of the flow (decisions of Sept 28):
 *
 * - The receiving club's director requests a transfer by typing the
 *   member's exact first and last name and choosing their current club.
 *   The server matches on normalized exact names inside that club's
 *   current-year roster and always answers "request sent", match or not, so
 *   the request can't be used to find out who is on another club's roster.
 *   A single match goes to the sending club (`PENDING`); anything else goes
 *   to the conference staff list (`UNMATCHED`).
 * - The receiving club sees only that its request is pending, never member
 *   details. Its roster row is created only when the sending club accepts,
 *   or conference staff finish (after 14 days) or override (any time, with a
 *   note). The sending club can also decline, which hands it to staff.
 *   Either side can cancel while it is open.
 * - Completing a transfer moves nothing else on its own: each of the
 *   member's open club-billed registrations waits on staff approval.
 */

export const ACKNOWLEDGE_WINDOW_DAYS = 14;

export function acknowledgeDueAt(initiatedAt: Date): Date {
  return new Date(initiatedAt.getTime() + ACKNOWLEDGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export type MemberTransferStatus = "PENDING" | "UNMATCHED" | "DECLINED" | "COMPLETED" | "CANCELLED";
export type MemberTransferResolution = "SENDING_CLUB_ACCEPTED" | "STAFF_FINISHED" | "STAFF_OVERRIDDEN";
export type MemberTransferStaffReason = "NO_MATCH" | "AMBIGUOUS_MATCH" | "ALREADY_PENDING" | "SAME_DIRECTOR";

/** Still open: either side may cancel, and staff may override. */
export const openTransferStatuses = ["PENDING", "UNMATCHED", "DECLINED"] as const satisfies readonly MemberTransferStatus[];

export function isOpenTransfer(status: MemberTransferStatus) {
  return (openTransferStatuses as readonly string[]).includes(status);
}

/** Staff's own labels: the full truth, for the conference queue only. */
export const memberTransferStaffStatusLabels: Record<MemberTransferStatus, string> = {
  PENDING: "Waiting on the sending club",
  UNMATCHED: "No match: needs staff",
  DECLINED: "Declined by the sending club",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const memberTransferStaffReasonLabels: Record<MemberTransferStaffReason, string> = {
  NO_MATCH: "No active member of that club has exactly that name",
  AMBIGUOUS_MATCH: "More than one active member of that club has that name",
  ALREADY_PENDING: "That member already has another open transfer",
  SAME_DIRECTOR: "The same person leads both clubs",
};

export const memberTransferResolutionLabels: Record<MemberTransferResolution, string> = {
  SENDING_CLUB_ACCEPTED: "Accepted by the sending club",
  STAFF_FINISHED: "Finished by conference staff",
  STAFF_OVERRIDDEN: "Overridden by conference staff",
};

/**
 * What the receiving club is told about its own request. Every open state
 * reads the same ("Pending"): telling a club its request was unmatched, or
 * declined, would tell it whether the name it typed is on that roster.
 */
export function receivingClubStatusLabel(status: MemberTransferStatus) {
  if (status === "COMPLETED") return "Completed";
  if (status === "CANCELLED") return "Cancelled";
  return "Pending";
}

/** What the sending club sees: it only ever sees matched requests. */
export function sendingClubStatusLabel(status: MemberTransferStatus) {
  if (status === "PENDING") return "Waiting on your answer";
  if (status === "DECLINED") return "Declined: with conference staff";
  if (status === "COMPLETED") return "Completed";
  if (status === "CANCELLED") return "Cancelled";
  return "Pending";
}

/**
 * Whether a still-pending transfer is overdue: the sending club hasn't
 * answered within the 14-day window. Only `PENDING` counts: a declined or
 * unmatched request is already with staff.
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
  if (fromOrganizationId === toOrganizationId) return "Choose the member's current club, not your own.";
  return null;
}

/**
 * The one name comparison the whole flow uses: Unicode-normalized, trimmed,
 * inner whitespace collapsed, case-folded. Exact after that, never "contains"
 * or fuzzy, so a typed name either names someone or it doesn't.
 */
export function normalizeTransferName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function sameTransferName(
  a: { firstName: string; lastName: string },
  b: { firstName: string; lastName: string },
) {
  return normalizeTransferName(a.firstName) === normalizeTransferName(b.firstName)
    && normalizeTransferName(a.lastName) === normalizeTransferName(b.lastName);
}

/** Lowercased, trimmed: the one email comparison notification dedupe uses. */
export function normalizeNotificationEmail(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Recipients deduped by normalized email: the same director leading both
 * clubs, or a director who is also the member's guardian, gets one notice.
 * The first entry for an address wins, so an account recipient (listed
 * before the guest email) keeps its account link.
 */
export function dedupeNotificationRecipients<T extends { email: string }>(recipients: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const recipient of recipients) {
    const key = normalizeNotificationEmail(recipient.email ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(recipient);
  }
  return unique;
}

/**
 * Registration move blockers (#489 decision 2). A move is refused when the
 * member has since left the receiving club, when the receiving club has no
 * usable registration for the event, when that registration is a draft or
 * on the waitlist, when the person is already on it, when their class seat
 * would put the receiving club over a class's per-club limit, or when
 * carrying their adjustment lines would break the same money rules a staff
 * adjustment has to follow. The approval list shows each for staff to
 * resolve.
 */
export type RegistrationMoveBlocker =
  | "ATTENDEE_GONE"
  | "SOURCE_NOT_OPEN"
  | "MEMBER_LEFT_RECEIVING_CLUB"
  | "NO_DESTINATION"
  | "DESTINATION_DRAFT"
  | "DESTINATION_WAITLISTED"
  | "DESTINATION_CANCELLED"
  | "ALREADY_ON_DESTINATION"
  | "CLUB_CLASS_LIMIT"
  | "TOTAL_CLAMPED"
  | "TOTAL_BELOW_ZERO"
  | "TOTAL_BELOW_PAID";

export const registrationMoveBlockerLabels: Record<RegistrationMoveBlocker, string> = {
  ATTENDEE_GONE: "This person is no longer on the old club's registration.",
  SOURCE_NOT_OPEN: "The old club's registration is no longer submitted or confirmed.",
  MEMBER_LEFT_RECEIVING_CLUB: "This person is no longer on the new club's roster. Skip this move.",
  NO_DESTINATION: "The new club has no registration for this event yet.",
  DESTINATION_DRAFT: "The new club's registration is still a draft.",
  DESTINATION_WAITLISTED: "The new club's registration is on the waitlist.",
  DESTINATION_CANCELLED: "The new club's registration was cancelled.",
  ALREADY_ON_DESTINATION: "This person is already on the new club's registration. Resolve it there, then skip this move.",
  CLUB_CLASS_LIMIT: "Moving this person's class seat would put the new club over that class's per-club limit. Change their class first.",
  TOTAL_CLAMPED: "One of these registrations has a total of $0, which may already be held at $0, so moving this person's adjustments would give the wrong amount. Fix the amounts with the adjustment tools first.",
  TOTAL_BELOW_ZERO: "Moving this person's adjustments would bring a registration's total below $0. Fix the amounts with the adjustment tools first.",
  TOTAL_BELOW_PAID: "Moving this person's adjustments would bring a registration's total below what has already been paid on it. Record a refund or adjust first.",
};

export type MoveMoney = { fromTotalCents: number; fromPaidCents: number; toTotalCents: number; toPaidCents: number; shiftCents: number };

/**
 * The money rules a move must keep (#489), the same ones a staff adjustment
 * keeps (`checkNewTotal`): the person's adjustment lines leave the old
 * registration and join the new one, so the old total moves by minus the
 * lines and the new total by plus the lines. Neither may go below $0 or
 * below what was already paid on it, and a stored $0 total may already be
 * clamped, which would make the shift wrong.
 */
export function moveMoneyBlocker(money: MoveMoney): RegistrationMoveBlocker | null {
  if (money.shiftCents === 0) return null;
  if (money.fromTotalCents === 0 || money.toTotalCents === 0) return "TOTAL_CLAMPED";
  const fromAfter = money.fromTotalCents - money.shiftCents;
  const toAfter = money.toTotalCents + money.shiftCents;
  if (fromAfter < 0 || toAfter < 0) return "TOTAL_BELOW_ZERO";
  if (fromAfter < money.fromPaidCents || toAfter < money.toPaidCents) return "TOTAL_BELOW_PAID";
  return null;
}

export function registrationMoveBlocker(input: {
  attendeeOnSource: boolean;
  sourceStatus: string | null;
  receivingMemberActive?: boolean;
  destination: { status: string; waitlisted: boolean; personAlreadyThere: boolean } | null;
  classLimitExceeded?: boolean;
  money?: MoveMoney | null;
}): RegistrationMoveBlocker | null {
  if (!input.attendeeOnSource) return "ATTENDEE_GONE";
  if (input.sourceStatus !== "SUBMITTED" && input.sourceStatus !== "CONFIRMED") return "SOURCE_NOT_OPEN";
  if (input.receivingMemberActive === false) return "MEMBER_LEFT_RECEIVING_CLUB";
  if (!input.destination) return "NO_DESTINATION";
  if (input.destination.status === "DRAFT") return "DESTINATION_DRAFT";
  if (input.destination.status === "WAITLISTED" || input.destination.waitlisted) return "DESTINATION_WAITLISTED";
  if (input.destination.status === "CANCELLED") return "DESTINATION_CANCELLED";
  if (input.destination.personAlreadyThere) return "ALREADY_ON_DESTINATION";
  if (input.classLimitExceeded) return "CLUB_CLASS_LIMIT";
  return input.money ? moveMoneyBlocker(input.money) : null;
}

/** Staff queue filters (#489 N2). */
export const staffQueueFilters = ["open", "overdue", "declined", "unmatched", "pending"] as const;
export type StaffQueueFilter = (typeof staffQueueFilters)[number];
