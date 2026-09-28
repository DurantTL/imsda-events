/**
 * Shared bits for the club member transfer screens (#489): one date format,
 * kept on one line at phone width, and one set of history labels, so the
 * director panel and the staff queue describe the same event the same way.
 */

export function formatTransferDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Chicago" });
}

/** A date that never breaks across lines ("Oct 12, 2026"). */
export function TransferDate({ iso }: { iso: string }) {
  return <span className="transfer-date">{formatTransferDate(iso)}</span>;
}

export const transferEventLabels: Record<string, string> = {
  REQUESTED: "Requested",
  ACCEPTED: "Accepted",
  DECLINED: "Declined; sent to conference staff",
  CANCELLED: "Cancelled",
  STAFF_FINISHED: "Finished by conference staff",
  STAFF_OVERRIDDEN: "Completed by conference staff",
  COMPLETED: "Completed",
  REGISTRATION_MOVE_QUEUED: "Registration move waiting for approval",
  REGISTRATION_MOVE_APPROVED: "Registration moved",
  REGISTRATION_MOVE_SKIPPED: "Registration move skipped",
  NOTIFIED: "Notice queued",
};

export function transferEventLabel(type: string) {
  return transferEventLabels[type] ?? type;
}
