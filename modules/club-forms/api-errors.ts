import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { SecretBoxError } from "@/lib/secret-box";
import { AccessDeniedError } from "@/modules/access/authorization";
import { ClubFormError, formBusyError, isLockTimeoutError } from "@/modules/club-forms/errors";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { readRosterJson, RosterBodyError } from "@/modules/club-rosters/api-errors";

export { readRosterJson as readClubFormJson };

const statusByCode: Record<ClubFormError["code"], number> = {
  TEMPLATE_NOT_FOUND: 404,
  CLUB_NOT_FOUND: 404,
  SUBMISSION_NOT_FOUND: 404,
  LINK_NOT_FOUND: 404,
  LINK_UNAVAILABLE: 404,
  MEMBER_NOT_FOUND: 404,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  ALREADY_SUBMITTED: 409,
  EMAIL_NOT_CONFIGURED: 503,
  ENCRYPTION_NOT_CONFIGURED: 503,
  SENSITIVE_UNREADABLE: 500,
  INVALID_TEMPLATE: 500,
  TEMPLATE_NEEDS_SYNC: 409,
  FORM_BUSY: 503,
};

/**
 * One error mapper for the club forms routes. It never logs a request body
 * (which can hold sensitive answers) and never echoes an answer back.
 */
export function clubFormApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json({ error: "INVALID_CLUB_FORM_REQUEST", message: error.issues[0]?.message ?? "Check the form and try again." }, { status: 400 });
  }
  if (error instanceof RosterBodyError) {
    return Response.json({ error: error.code, message: error.message }, { status: 400 });
  }
  if (error instanceof RosterAccessError || error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ClubFormError) {
    return Response.json(
      { error: error.code, message: error.message, ...(error.issues.length > 0 ? { issues: error.issues } : {}) },
      { status: statusByCode[error.code], ...(error.code === "FORM_BUSY" ? { headers: { "Retry-After": "60" } } : {}) },
    );
  }
  if (isLockTimeoutError(error)) {
    const busy = formBusyError();
    return Response.json({ error: busy.code, message: busy.message }, { status: statusByCode.FORM_BUSY, headers: { "Retry-After": "60" } });
  }
  if (error instanceof SecretBoxError) {
    return Response.json({ error: "ENCRYPTION_NOT_CONFIGURED", message: "Encryption isn't set up on this server." }, { status: 503 });
  }
  logError(`${action} failed`, error);
  return Response.json({ error: "CLUB_FORM_REQUEST_FAILED", message: `${action} could not be completed.` }, { status: 500 });
}
