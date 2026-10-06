export type LodgingErrorCode =
  | "EVENT_NOT_FOUND"
  | "PROPERTY_UNKNOWN"
  | "PROPERTY_ALREADY_SET"
  | "NO_PROPERTY"
  | "UNIT_NOT_FOUND"
  | "HOLD_NOT_FOUND"
  | "HOLD_RELEASED"
  | "HOLD_OVERLAP"
  | "WINDOW_OUTSIDE_EVENT"
  | "NO_NIGHTS";

/** Every refusal the lodging module can make (#198). Free of server-only imports so any layer can catch it. */
export class LodgingError extends Error {
  constructor(
    public readonly code: LodgingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LodgingError";
  }
}

export function lodgingErrorStatus(code: LodgingErrorCode) {
  switch (code) {
    case "EVENT_NOT_FOUND":
    case "UNIT_NOT_FOUND":
    case "HOLD_NOT_FOUND":
    case "PROPERTY_UNKNOWN":
      return 404;
    case "PROPERTY_ALREADY_SET":
    case "HOLD_OVERLAP":
    case "HOLD_RELEASED":
    case "NO_PROPERTY":
      return 409;
    default:
      return 400;
  }
}
