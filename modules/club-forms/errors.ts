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
  | "INVALID_TEMPLATE"
  | "TEMPLATE_NEEDS_SYNC"
  | "FORM_BUSY"
  | "FORM_UNAVAILABLE";

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

export const FORM_BUSY_MESSAGE = "This form is being updated. Please try again in a minute.";

export function formBusyError() {
  return new ClubFormError("FORM_BUSY", FORM_BUSY_MESSAGE);
}

export const FORM_UNAVAILABLE_MESSAGE = "This form is temporarily unavailable. Please try again later.";

/** The stored template is behind the code and has not been synced (and re-sealed) yet: nothing can be saved. */
export function formUnavailableError() {
  return new ClubFormError("FORM_UNAVAILABLE", FORM_UNAVAILABLE_MESSAGE);
}

/**
 * A wait for a row lock that gave up: Postgres SQLSTATE 55P03 (lock_timeout,
 * which Prisma reports as a failed raw query). Only this reads as "being
 * updated" at the API boundary; any other database error is a real failure.
 */
export function isLockTimeoutError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const { code, meta, message } = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (code === "55P03" || meta?.code === "55P03") return true;
  return typeof message === "string" && /55P03|lock timeout/i.test(message);
}

/** Prisma's own interactive-transaction error (expired or closed). Only the lock handler treats it as busy. */
export function isTransactionApiError(error: unknown) {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2028";
}
