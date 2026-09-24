import { z } from "zod";
import { logError } from "@/lib/logger";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { ClubRegistrationError } from "@/modules/club-registrations/repository";
import { PublicRegistrationError } from "@/modules/forms/public-repository";
import { ClassSelectionError } from "@/modules/honors/enrollment-repository";
import { RegistrationAmendmentError } from "@/modules/registrations/amendments-repository";

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
    const status = error.code === "EVENT_NOT_FOUND" || error.code === "REGISTRATION_NOT_FOUND"
      ? 404
      : error.code === "DRAFT_TOO_LARGE"
        ? 413
        : error.code === "REGISTRATION_CLOSED"
          ? 410
          : error.code === "ATTENDEES_INVALID"
            ? 422
            : 409;
    return Response.json({ error: error.code, message: error.message }, { status, headers: noStore });
  }
  if (error instanceof RegistrationAmendmentError) {
    const status = error.code === "REGISTRATION_NOT_FOUND"
      ? 404
      : error.code === "INVALID_AMENDMENT" || error.code === "PROTECTED_FIELD_CHANGED" || error.code === "ATTENDEE_IDENTITY_CHANGED"
        ? 422
        : 409;
    // Never the engine's own details or staff wording: a director gets a
    // message written for them and, for field problems, only which answer
    // of which person needs attention.
    return Response.json(
      { error: error.code, message: directorAmendmentMessage(error), issues: directorSafeIssues(error.issues) },
      { status, headers: noStore },
    );
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

function attendeeName(error: RegistrationAmendmentError) {
  const name = error.details.attendeeName;
  return typeof name === "string" && name.trim() ? name.trim() : "Someone";
}

/** The amendment engine's refusals, reworded for a club director (H3b, #366). */
export function directorAmendmentMessage(error: RegistrationAmendmentError) {
  switch (error.code) {
    case "ATTENDEE_HAS_HISTORY":
      return `${attendeeName(error)} has already checked in or been substituted, so they can't be removed here. Tick them again to keep them, or ask the event team.`;
    case "ATTENDEE_IDENTITY_CHANGED":
      return `${attendeeName(error)}'s name changed on your roster since you registered. Ask the event team to update it.`;
    case "PAYMENT_ADJUSTMENT_REQUIRED":
      return "This change would lower what your church owes below what's already paid. Ask the event team.";
    case "EVENT_CAPACITY_UNAVAILABLE":
      return "The event doesn't have room for everyone you chose. Remove someone, or ask the event team.";
    case "INVALID_AMENDMENT":
      return error.issues.length > 0
        ? "Review the highlighted answers and try again."
        : "That change can't be made here. Ask the event team.";
    case "PROTECTED_FIELD_CHANGED":
      return "Contact details and promo codes can't be changed here. Ask the event team.";
    case "REGISTRATION_CHANGED":
    case "ATTENDEE_NOT_FOUND":
    case "QUOTE_CHANGED":
    case "AMENDMENT_CONFLICT":
      return "Your registration changed while you were editing. Refresh the page and make your changes again.";
    case "IDEMPOTENCY_KEY_REUSED":
      return "That save couldn't be matched to your changes. Refresh the page and try again.";
    case "REGISTRATION_NOT_ACTIVE":
    case "PUBLIC_FORM_REQUIRED":
    case "REGISTRATION_NOT_FOUND":
      return "This registration can't be changed here. Contact the event team.";
  }
}

/** Only which answer of which person needs attention, and a message about it. */
function directorSafeIssues(issues: RegistrationAmendmentError["issues"]) {
  return issues.map((issue) => {
    const clientId = (issue as { clientId?: unknown }).clientId;
    return {
      key: issue.key,
      message: issue.message,
      clientId: typeof clientId === "string" ? clientId : null,
    };
  });
}
