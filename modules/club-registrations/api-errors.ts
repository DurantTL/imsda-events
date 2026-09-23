import { z } from "zod";
import { logError } from "@/lib/logger";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { ClubRegistrationError } from "@/modules/club-registrations/repository";
import { PublicRegistrationError } from "@/modules/forms/public-repository";
import { ClassSelectionError } from "@/modules/honors/enrollment-repository";

const noStore = { "Cache-Control": "no-store" };

export function clubRegistrationApiError(error: unknown, action: string) {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_REQUEST", message: error.issues[0]?.message ?? "The request is invalid.", issues: error.issues },
      { status: 400, headers: noStore },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "INVALID_JSON", message: "The request is not valid JSON." }, { status: 400, headers: noStore });
  }
  if (error instanceof RosterAccessError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status, headers: noStore });
  }
  if (error instanceof ClubRegistrationError) {
    const status = error.code === "EVENT_NOT_FOUND" ? 404 : error.code === "DRAFT_TOO_LARGE" ? 413 : 409;
    return Response.json({ error: error.code, message: error.message }, { status, headers: noStore });
  }
  if (error instanceof ClassSelectionError) {
    const status = error.code === "NOT_REGISTERED" || error.code === "ATTENDEE_NOT_FOUND"
      ? 404
      : error.code === "DEADLINE_PASSED" ? 410 : error.code === "SELECTION_INVALID" ? 422 : 409;
    return Response.json({ error: error.code, message: error.message }, { status, headers: noStore });
  }
  if (error instanceof PublicRegistrationError) {
    let status = 409;
    if (error.code === "FORM_NOT_FOUND") status = 404;
    if (error.code === "REGISTRATION_CLOSED") status = 410;
    if (error.code === "INVALID_SUBMISSION" || error.code === "CLUB_ATTENDEES_INVALID") status = 422;
    return Response.json({ error: error.code, message: error.message, issues: error.issues }, { status, headers: noStore });
  }
  // Never log the body: it can hold answers about minors.
  logError(`${action} failed`, error);
  return Response.json(
    { error: "CLUB_REGISTRATION_FAILED", message: `${action} could not be completed. Nothing was submitted.` },
    { status: 500, headers: noStore },
  );
}
