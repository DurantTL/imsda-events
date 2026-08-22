import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import {
  RegistrationAttendeeOperationError,
  updateRegistrationAttendeeEmail,
} from "@/modules/registrations/repository";
import { attendeeEmailUpdateSchema } from "@/modules/registrations/schemas";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

async function patchHandler(
  request: Request,
  context: { params: Promise<{ eventId: string; registrationId: string; attendeeId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId, attendeeId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_REGISTRATION",
      findActiveMembership
    );
    const input = attendeeEmailUpdateSchema.parse(await request.json());
    const registration = await updateRegistrationAttendeeEmail(
      eventId,
      registrationId,
      attendeeId,
      input.email,
      access.user.id,
    );
    return Response.json({ registration });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_ATTENDEE", issues: error.issues }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof RegistrationAttendeeOperationError) {
      return Response.json(
        { error: error.code, message: error.message, details: error.details },
        { status: error.code === "ATTENDEE_NOT_FOUND" ? 404 : 409 }
      );
    }
    logError("Unable to update registration attendee email", error);
    return Response.json({ error: "ATTENDEE_EMAIL_UPDATE_FAILED" }, { status: 500 });
  }
}

export const PATCH = withRequestContext(patchHandler);
