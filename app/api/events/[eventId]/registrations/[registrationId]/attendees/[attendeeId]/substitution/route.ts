import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  ensureEventMessagingDefaults,
  processQueuedMessageIdsAfterCommit,
} from "@/modules/communications/messaging-repository";
import { findActiveMembership } from "@/modules/events/repository";
import {
  RegistrationOperationError,
  substituteRegistrationAttendee,
} from "@/modules/registrations/operations-repository";
import { attendeeSubstitutionInputSchema } from "@/modules/registrations/schemas";

const noStoreHeaders = { "Cache-Control": "no-store" };

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return Response.json(
      {
        error: "INVALID_ATTENDEE_SUBSTITUTION_REQUEST",
        message: "Review the replacement attendee details and submit the two-step substitution again.",
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
  if (error instanceof RegistrationOperationError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      {
        status: error.code === "REGISTRATION_NOT_FOUND"
          || error.code === "ATTENDEE_NOT_FOUND"
          ? 404
          : 409,
        headers: noStoreHeaders,
      },
    );
  }
  console.error(
    "Attendee substitution failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    { error: "ATTENDEE_SUBSTITUTION_FAILED" },
    { status: 500, headers: noStoreHeaders },
  );
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{
      eventId: string;
      registrationId: string;
      attendeeId: string;
    }>;
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
    const { eventId, registrationId, attendeeId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_REGISTRATION",
      findActiveMembership,
    );
    const input = attendeeSubstitutionInputSchema.parse(await request.json());
    await ensureEventMessagingDefaults(eventId);
    const result = await substituteRegistrationAttendee(
      eventId,
      registrationId,
      attendeeId,
      input,
      {
        id: access.user.id,
        displayName: access.user.displayName,
      },
    );
    try {
      await processQueuedMessageIdsAfterCommit(result.pendingMessageIds);
    } catch (error) {
      console.error(
        "Substitution notice processing failed after commit",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    return Response.json(result.response, {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
