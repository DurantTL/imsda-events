/**
 * Q1 (#412): checking in a whole club (or part of one) is exactly a series of
 * single check-ins, one attendee at a time, through the same
 * `requestCheckIn` the single row and the scanner use. That keeps the
 * per-attendee check-in record, undo, idempotent offline retries and reports
 * identical to a single check-in. Both the arrival roster's club view and
 * the scanner's club view call this one helper.
 */

export type SequentialCheckInStatus = "CONFIRMED" | "QUEUED" | "CONFLICT";

export type SequentialCheckInResult = {
  status: SequentialCheckInStatus;
  message: string;
  checkedInAt?: string;
};

export type SequentialCheckInProgress = {
  /** 1-based position of the attendee being checked in now. */
  current: number;
  total: number;
  attendeeId: string;
};

export type SequentialCheckInOutcome = {
  perAttendee: Record<string, SequentialCheckInResult>;
  confirmed: number;
  queued: number;
  needsReview: number;
};

const unexpectedFailureMessage =
  "This check-in could not be completed and needs staff review.";

/**
 * Checks in each id in order, awaiting one before starting the next (never
 * in parallel). A throw for one attendee is recorded as needing review and
 * the loop carries on, so one failure never stops the rest of the club.
 */
export async function checkInSequentially(
  attendeeIds: readonly string[],
  requestCheckIn: (attendeeId: string) => Promise<SequentialCheckInResult>,
  onProgress?: (progress: SequentialCheckInProgress) => void,
): Promise<SequentialCheckInOutcome> {
  const outcome: SequentialCheckInOutcome = {
    perAttendee: {},
    confirmed: 0,
    queued: 0,
    needsReview: 0,
  };
  const total = attendeeIds.length;
  for (const [index, attendeeId] of attendeeIds.entries()) {
    onProgress?.({ current: index + 1, total, attendeeId });
    let result: SequentialCheckInResult;
    try {
      result = await requestCheckIn(attendeeId);
    } catch (error) {
      result = {
        status: "CONFLICT",
        message: error instanceof Error && error.message
          ? error.message
          : unexpectedFailureMessage,
      };
    }
    outcome.perAttendee[attendeeId] = result;
    if (result.status === "CONFIRMED") outcome.confirmed += 1;
    else if (result.status === "QUEUED") outcome.queued += 1;
    else outcome.needsReview += 1;
  }
  return outcome;
}

/**
 * What staff read after a bulk run: how many were confirmed, how many are
 * only queued on this device, and by name who needs review.
 */
export function sequentialCheckInSummary(
  attendeeIds: readonly string[],
  outcome: SequentialCheckInOutcome,
  nameOf: (attendeeId: string) => string,
) {
  const reviewNames = attendeeIds
    .filter((id) => outcome.perAttendee[id]?.status === "CONFLICT")
    .map(nameOf);
  return `Checked in ${outcome.confirmed} of ${attendeeIds.length}`
    + (outcome.queued > 0 ? `, ${outcome.queued} queued offline (not confirmed yet)` : "")
    + (outcome.needsReview > 0
      ? `, ${outcome.needsReview} ${outcome.needsReview === 1 ? "needs" : "need"} review: ${reviewNames.join(", ")}`
      : "")
    + ".";
}
