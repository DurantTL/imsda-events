import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { ClubImportParseError } from "@/modules/club-imports/domain";
import { ClubInviteError } from "@/modules/club-imports/invites";

export function clubImportApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json({ error: "INVALID_CLUB_IMPORT", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  }
  if (error instanceof SyntaxError || error instanceof ClubImportParseError) {
    return Response.json({
      error: "INVALID_EXPORT",
      message: error instanceof ClubImportParseError ? error.message : "That file isn't valid JSON. Export the form's entries as JSON and try again.",
    }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ClubInviteError) {
    const status = error.code === "INVITE_NOT_FOUND" ? 404
      : error.code === "EMAIL_NOT_CONFIGURED" ? 503
      : error.code === "INVITE_ROLE_NOT_ALLOWED" ? 403
      : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  // Never log the body: an export holds names, emails, and minors' ages.
  logError(`${action} failed`, error);
  return Response.json({ error: "CLUB_IMPORT_FAILED", message: `${action} could not be completed.` }, { status: 500 });
}
