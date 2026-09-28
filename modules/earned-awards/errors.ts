export type EarnedAwardErrorCode =
  | "EVENT_NOT_FOUND"
  | "NOT_A_CLUB_EVENT"
  | "ITEM_NOT_FOUND"
  | "ITEM_NOT_ALLOWED"
  | "RULE_NOT_FOUND"
  | "RULE_NOT_READY"
  | "HONOR_NOT_FOUND"
  | "PREVIEW_CHANGED"
  | "RULES_CONFLICT";

/** Staff-side earned award errors (#532): event links and Master Award rules. */
export class EarnedAwardError extends Error {
  constructor(public readonly code: EarnedAwardErrorCode, message: string) {
    super(message);
    this.name = "EarnedAwardError";
  }
}
