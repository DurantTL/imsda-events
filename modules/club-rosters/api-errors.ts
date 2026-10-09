import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { isLockTimeoutError } from "@/lib/prisma-errors";
import { AttendeeMfaError } from "@/modules/attendee-accounts/mfa-service";
import { ClubInviteError } from "@/modules/club-imports/invites";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { RosterExportError } from "@/modules/club-rosters/export-repository";
import { RosterOperationError } from "@/modules/club-rosters/repository";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { OrganizationOperationError } from "@/modules/organizations/repository";

/**
 * Reads a JSON request body, turning an empty or malformed one into a 400
 * (`INVALID_JSON_BODY`) instead of the generic 500 (#566).
 */
export class RosterBodyError extends Error {
  readonly code = "INVALID_JSON_BODY";
}

export async function readRosterJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new RosterBodyError("Send a JSON request body.");
  }
}

export function rosterApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_ROSTER_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof RosterBodyError) {
    return Response.json({ error: error.code, message: error.message }, { status: 400 });
  }
  if (error instanceof RosterAccessError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof RosterOperationError) {
    const status = error.code === "MEMBER_NOT_FOUND"
      ? 404
      : error.code === "BIRTH_DATE_INVALID" || error.code === "GENDER_REQUIRED" || error.code === "GUARDIAN_PHONE_INVALID"
        ? 400
        : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof RosterExportError) {
    const status = error.code === "FORMAT_NOT_FOUND" ? 404
      : error.code === "SENSITIVE_ACCESS_DENIED" ? 403
      : error.code === "FORMAT_NAME_TAKEN" ? 409
      : 400;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  // Club team and profile changes (#375) raise the directory's own errors.
  if (error instanceof OrganizationOperationError) return organizationApiError(error, action);
  // Club-created invites (#425) reuse the import invite's errors.
  if (error instanceof ClubInviteError) {
    const status = error.code === "INVITE_NOT_FOUND" ? 404
      : error.code === "EMAIL_NOT_CONFIGURED" ? 503
      : error.code === "INVITE_ROLE_NOT_ALLOWED" || error.code === "INVITE_OWN_ACCOUNT" ? 403
      : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof AttendeeMfaError) {
    return Response.json(
      { error: error.code, message: error.message },
      {
        status: error.code === "MFA_NOT_ENROLLED" ? 403
          : error.code === "MFA_LOCKED" ? 429
          : 400,
      },
    );
  }
  // A club-order lock wait that gave up (nothing was written): ask to retry.
  // P2028: the interactive transaction ran past its limit while waiting.
  if (isLockTimeoutError(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028")) {
    return Response.json(
      { error: "ROSTER_BUSY", message: "The club's orders are busy right now. Try again in a moment." },
      { status: 503 },
    );
  }
  // Never log the request body here: it can hold a birth date.
  logError(`${action} failed`, error);
  return Response.json(
    { error: "ROSTER_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
