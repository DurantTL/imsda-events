export type HealthRecordErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "MEMBER_NOT_FOUND"
  | "LINK_UNAVAILABLE"
  | "LINK_NOT_FOUND"
  | "VALIDATION_FAILED"
  | "EMAIL_NOT_CONFIGURED"
  | "ENCRYPTION_NOT_CONFIGURED"
  | "CONFLICT"
  | "UNREADABLE";

/** A health record rule that stopped a request. Messages never carry a health value. */
export class HealthRecordError extends Error {
  constructor(
    public readonly code: HealthRecordErrorCode,
    message: string,
    public readonly issues: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = "HealthRecordError";
  }
}

/** The one answer for every switched-off or unavailable surface: indistinguishable from a missing page. */
export const HEALTH_NOT_FOUND_MESSAGE = "That page could not be found.";

/** One answer for every way a person can be out of reach (not on the roster, not an attendee, outside the window, event not open). */
export const HEALTH_MEMBER_NOT_FOUND_MESSAGE = "That person could not be found.";

export const HEALTH_LINK_UNAVAILABLE_MESSAGE = "This private link is invalid or no longer active.";
