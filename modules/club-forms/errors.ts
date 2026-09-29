import type { ClubFormIssue } from "@/modules/club-forms/domain";

export type ClubFormErrorCode =
  | "TEMPLATE_NOT_FOUND"
  | "CLUB_NOT_FOUND"
  | "SUBMISSION_NOT_FOUND"
  | "LINK_NOT_FOUND"
  | "LINK_UNAVAILABLE"
  | "MEMBER_NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION_FAILED"
  | "ALREADY_SUBMITTED"
  | "EMAIL_NOT_CONFIGURED"
  | "ENCRYPTION_NOT_CONFIGURED"
  | "SENSITIVE_UNREADABLE"
  | "INVALID_TEMPLATE";

/** A club forms rule that stopped a request. Messages never carry an answer. */
export class ClubFormError extends Error {
  constructor(
    public readonly code: ClubFormErrorCode,
    message: string,
    public readonly issues: ClubFormIssue[] = [],
  ) {
    super(message);
    this.name = "ClubFormError";
  }
}
