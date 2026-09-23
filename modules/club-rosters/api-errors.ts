import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { AttendeeMfaError } from "@/modules/attendee-accounts/mfa-service";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { RosterOperationError } from "@/modules/club-rosters/repository";

export function rosterApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_ROSTER_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof RosterAccessError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof RosterOperationError) {
    const status = error.code === "MEMBER_NOT_FOUND" ? 404 : error.code === "BIRTH_DATE_INVALID" ? 400 : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof AttendeeMfaError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "MFA_NOT_ENROLLED" ? 403 : 400 },
    );
  }
  // Never log the request body here: it can hold a birth date.
  logError(`${action} failed`, error);
  return Response.json(
    { error: "ROSTER_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
