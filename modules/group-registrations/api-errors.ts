import { z } from "zod";
import { logError } from "@/lib/logger";
import { isBusyDatabaseError, logExpiredTransaction } from "@/modules/event-locations/api-errors";
import { EventLocationError, eventLocationErrorStatus, locationBusyMessage } from "@/modules/event-locations/errors";
import { PublicRegistrationError } from "@/modules/forms/public-repository";
import { GroupRegistrationError } from "@/modules/group-registrations/repository";
import { ClassSelectionError } from "@/modules/honors/enrollment-repository";
import { RegistrationAmendmentError } from "@/modules/registrations/amendments-repository";

const noStore = { "Cache-Control": "no-store" };

/** The amendment engine's refusals, reworded for a group's contact (#650). Never staff wording or details. */
export function groupAmendmentMessage(error: RegistrationAmendmentError) {
  switch (error.code) {
    case "ATTENDEE_HAS_HISTORY":
      return "That person has already checked in, so they can't be removed here. Keep them, or ask the event team.";
    case "ATTENDEE_IDENTITY_CHANGED":
      return "A person's name can't be changed here. Remove them and add the right person, or ask the event team.";
    case "PAYMENT_ADJUSTMENT_REQUIRED":
      return "This change can't be made here. Ask the event team.";
    case "EVENT_CAPACITY_UNAVAILABLE":
      return "The event doesn't have room for everyone you chose. Remove someone, or ask the event team.";
    case "LOCATION_CAPACITY_UNAVAILABLE":
      return "That location doesn't have room for everyone you chose. Remove someone, choose another location, or ask the event team.";
    case "LOCATION_HAS_CLASS_PICKS":
      return error.message;
    case "INVALID_AMENDMENT":
      return error.issues.length > 0
        ? "Review the highlighted answers and try again."
        : "That change can't be made here. Ask the event team.";
    case "PROTECTED_FIELD_CHANGED":
      return "Contact details can't be changed here. Use the contact form on your registration page.";
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

/** The JSON a public group route answers with for any failure; nothing staff-only, never the request body. */
export function groupRegistrationApiError(error: unknown, action: string) {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_REQUEST", message: error.issues[0]?.message ?? "The request is invalid.", issues: error.issues },
      { status: 400, headers: noStore },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "INVALID_JSON", message: "The request is not valid JSON." }, { status: 400, headers: noStore });
  }
  if (error instanceof EventLocationError) {
    return Response.json({ error: error.code, message: error.message }, { status: eventLocationErrorStatus(error.code), headers: noStore });
  }
  if (isBusyDatabaseError(error)) {
    logExpiredTransaction(error, action);
    return Response.json({ error: "LOCATION_BUSY", message: locationBusyMessage }, { status: 503, headers: noStore });
  }
  if (error instanceof GroupRegistrationError) {
    const status = error.code === "EVENT_NOT_FOUND" || error.code === "REGISTRATION_NOT_FOUND"
      ? 404
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
    const issues = error.issues.map((issue) => {
      const clientId = (issue as { clientId?: unknown }).clientId;
      return { key: issue.key, message: issue.message, clientId: typeof clientId === "string" ? clientId : null };
    });
    return Response.json({ error: error.code, message: groupAmendmentMessage(error), issues }, { status, headers: noStore });
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
    if (error.code === "INVALID_SUBMISSION" || error.code === "GROUP_ATTENDEES_INVALID") status = 422;
    return Response.json({ error: error.code, message: error.message, issues: error.issues }, { status, headers: noStore });
  }
  // Never log the body: it can hold answers about minors.
  logError(`${action} failed`, error);
  return Response.json(
    { error: "GROUP_REGISTRATION_FAILED", message: `${action} could not be completed. Nothing was submitted.` },
    { status: 500, headers: noStore },
  );
}
