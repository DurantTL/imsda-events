import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { DriverVerificationError } from "@/modules/driver-verification/repository";

export function driverVerificationApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_DRIVER_VERIFICATION_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof RosterAccessError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof DriverVerificationError) {
    const status = error.code === "PERSON_NOT_FOUND" ? 404 : error.code === "SELF_REVIEW" ? 403 : 400;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  // Never log the request body: it may carry a reviewer's note.
  logError(`${action} failed`, error);
  return Response.json(
    { error: "DRIVER_VERIFICATION_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
