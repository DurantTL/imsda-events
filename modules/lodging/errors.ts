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
  | "NO_NIGHTS"
  // Preferences, roommate requests and household rules (#199)
  | "REGISTRATION_NOT_FOUND"
  | "REGISTRATION_NOT_ACTIVE"
  | "PREFERENCES_NOT_COLLECTED"
  | "DEADLINE_PASSED"
  | "REASON_REQUIRED"
  | "CATEGORY_NOT_OFFERED"
  | "CATEGORY_FULL"
  | "DATES_OUTSIDE_EVENT"
  | "PARTY_TOO_LARGE"
  | "SENSITIVE_DATA_FORBIDDEN"
  | "ROOMMATE_NOT_FOUND"
  | "ROOMMATE_INVALID"
  | "ROOMMATE_DECIDED"
  | "RULE_NOT_FOUND"
  | "RULE_INVALID"
  | "RULE_ENDED"
  | "PERSON_NOT_ON_EVENT"
  | "ITEM_NOT_FOUND"
  | "EDIT_POLICY_REQUIRES_VERIFICATION"
  | "FLAGS_STAFF_ONLY"
  | "BELOW_MINIMUM_NIGHTS"
  | "REGISTRATION_NOT_ELIGIBLE";

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
    case "REGISTRATION_NOT_FOUND":
    case "ROOMMATE_NOT_FOUND":
    case "RULE_NOT_FOUND":
    case "ITEM_NOT_FOUND":
      return 404;
    case "SENSITIVE_DATA_FORBIDDEN":
    case "EDIT_POLICY_REQUIRES_VERIFICATION":
    case "FLAGS_STAFF_ONLY":
      return 403;
    case "PROPERTY_ALREADY_SET":
    case "HOLD_OVERLAP":
    case "HOLD_RELEASED":
    case "NO_PROPERTY":
    case "REGISTRATION_NOT_ACTIVE":
    case "PREFERENCES_NOT_COLLECTED":
    case "DEADLINE_PASSED":
    case "CATEGORY_FULL":
    case "ROOMMATE_DECIDED":
    case "RULE_ENDED":
    case "REGISTRATION_NOT_ELIGIBLE":
      return 409;
    default:
      return 400;
  }
}
