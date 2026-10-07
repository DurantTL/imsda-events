import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import { isBusyDatabaseError, logExpiredTransaction } from "@/modules/event-locations/api-errors";
import { ClubTeamError, clubTeamErrorStatus } from "@/modules/club-teams/errors";
import { EventLocationError, eventLocationErrorStatus, locationBusyMessage } from "@/modules/event-locations/errors";
import { findActiveMembership } from "@/modules/events/repository";
import { GroupRegistrationError, groupStaffAmendmentOptions } from "@/modules/group-registrations/repository";
import {
  amendRegistration,
  previewRegistrationAmendment,
  RegistrationAmendmentError,
} from "@/modules/registrations/amendments-repository";
import { registrationAmendmentInputSchema } from "@/modules/registrations/schemas";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const noStoreHeaders = { "Cache-Control": "no-store" };

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return Response.json(
      {
        error: "INVALID_AMENDMENT_REQUEST",
        message: "Review the registration changes and request a new quote.",
        ...(error instanceof z.ZodError ? { issues: error.issues } : {}),
      },
      { status: 400, headers: noStoreHeaders },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status, headers: noStoreHeaders },
    );
  }
  if (error instanceof RegistrationAmendmentError) {
    const status = error.code === "REGISTRATION_NOT_FOUND"
      ? 404
      : error.code === "INVALID_AMENDMENT"
        || error.code === "PROTECTED_FIELD_CHANGED"
        || error.code === "ATTENDEE_IDENTITY_CHANGED"
        ? 422
        : 409;
    return Response.json(
      {
        error: error.code,
        message: error.message,
        issues: error.issues,
        details: error.details,
      },
      { status, headers: noStoreHeaders },
    );
  }
  // The change breaks the event's team rules, or puts someone on two teams of a club (#809).
  if (error instanceof ClubTeamError) {
    return Response.json(
      { error: error.code, message: error.message, problems: error.problems },
      { status: clubTeamErrorStatus(error.code), headers: noStoreHeaders },
    );
  }
  // A group's class picks no longer fit the change (#650).
  if (error instanceof GroupRegistrationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "ATTENDEES_INVALID" ? 422 : 409, headers: noStoreHeaders },
    );
  }
  if (error instanceof EventLocationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: eventLocationErrorStatus(error.code), headers: noStoreHeaders },
    );
  }
  // A location lock wait that gave up, or a transaction that timed out: nothing was saved (#413).
  if (isBusyDatabaseError(error)) {
    logExpiredTransaction(error, "Registration amendment");
    return Response.json(
      { error: "LOCATION_BUSY", message: locationBusyMessage },
      { status: 503, headers: noStoreHeaders },
    );
  }
  logError("Registration amendment failed", error);
  return Response.json(
    {
      error: "REGISTRATION_AMENDMENT_FAILED",
      message: "The registration was not changed.",
    },
    { status: 500, headers: noStoreHeaders },
  );
}

async function postHandler(
  request: Request,
  context: {
    params: Promise<{ eventId: string; registrationId: string }>;
  },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) {
    originError.headers.set("Cache-Control", "no-store");
    return originError;
  }
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return Response.json(
      {
        error: "JSON_CONTENT_TYPE_REQUIRED",
        message: "Send this request as application/json.",
      },
      { status: 415, headers: noStoreHeaders },
    );
  }

  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_REGISTRATION",
      findActiveMembership,
    );
    const input = registrationAmendmentInputSchema.parse(await request.json());
    // A group registration is amended under the same options as its contact's edit (#650).
    const groupOptions = await groupStaffAmendmentOptions(eventId, registrationId, input);
    if (input.previewOnly) {
      const preview = groupOptions
        ? await previewRegistrationAmendment(eventId, registrationId, input, groupOptions)
        : await previewRegistrationAmendment(eventId, registrationId, input);
      return Response.json(
        { preview },
        { status: 200, headers: noStoreHeaders },
      );
    }
    const staffActor = { kind: "STAFF" as const, id: access.user.id, displayName: access.user.displayName };
    const { pendingMessageIds, ...result } = groupOptions
      ? await amendRegistration(eventId, registrationId, input, staffActor, new Date(), groupOptions)
      : await amendRegistration(eventId, registrationId, input, staffActor);
    try {
      await processQueuedMessageIdsAfterCommit(pendingMessageIds);
    } catch (error) {
      logError("Registration update notice processing failed after commit", error);
    }
    return Response.json(result, {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = withRequestContext(postHandler);
