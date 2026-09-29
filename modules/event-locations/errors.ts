export type EventLocationErrorCode =
  | "EVENT_NOT_FOUND"
  | "LOCATION_NOT_FOUND"
  | "LOCATION_NAME_TAKEN"
  | "LOCATION_IN_USE"
  | "LOCATION_LIMIT_REACHED"
  | "LOCATION_CAPACITY_BELOW_USAGE"
  | "LOCATION_ORDER_MISMATCH"
  | "LOCATION_REQUIRED"
  | "LOCATION_INVALID"
  | "LOCATION_FULL"
  | "LOCATION_CLOSED"
  | "LOCATION_BUSY";

/**
 * Every refusal the locations module can make (#413), for staff setup and for
 * the registration paths that admit a club to a location. Kept free of
 * server-only imports so any layer can catch it.
 */
export class EventLocationError extends Error {
  constructor(
    public readonly code: EventLocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EventLocationError";
  }
}

/**
 * Interactive transaction timeout for anything that waits on a location lock.
 * Prisma's default is 5s, the same as the 5s lock wait, so a held lock would
 * surface as an expired transaction (P2028) instead of a lock timeout
 * (55P03); this leaves room for the wait plus the work after it.
 */
export const locationTransactionTimeoutMs = 20_000;

export const locationBusyMessage = "That is being updated by someone else right now. Nothing was saved. Try again in a moment.";

/** HTTP status for each refusal. A busy lock is retryable (503); a full or closed location is a conflict or gone. */
export function eventLocationErrorStatus(code: EventLocationErrorCode) {
  switch (code) {
    case "EVENT_NOT_FOUND":
    case "LOCATION_NOT_FOUND":
      return 404;
    case "LOCATION_REQUIRED":
    case "LOCATION_INVALID":
    case "LOCATION_ORDER_MISMATCH":
      return 422;
    case "LOCATION_CLOSED":
      return 410;
    case "LOCATION_BUSY":
      return 503;
    default:
      return 409;
  }
}
