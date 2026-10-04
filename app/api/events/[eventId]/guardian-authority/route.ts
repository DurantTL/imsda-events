import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import {
  GuardianAuthorityError,
  dismissConflict,
  revokeResponsibleAdult,
  setResponsibleAdult,
} from "@/modules/guardian-authority/repository";
import { guardianAuthorityActionSchema } from "@/modules/guardian-authority/schemas";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Staff set, change or revoke the responsible adult of a minor, or close a conflicting claim (#131).
 * MANAGE_REGISTRATION on the event in the URL, checked here; the service refuses any attendee, adult or review
 * item that is not on that event. Same-origin only. Takes the acting user from the session, never the body.
 */

type RouteContext = { params: Promise<{ eventId: string }> };

function statusFor(error: GuardianAuthorityError) {
  switch (error.code) {
    case "EVENT_NOT_FOUND":
    case "ATTENDEE_NOT_FOUND":
    case "CONFLICT_NOT_FOUND":
      return 404;
    case "REASON_REQUIRED":
    case "CHOICES_INVALID":
      return 400;
    default:
      return 409;
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const { user } = await requirePermission(await getCurrentSession(), eventId, "MANAGE_REGISTRATION", findActiveMembership);
    const body = guardianAuthorityActionSchema.parse(await request.json().catch(() => ({})));
    const actorUserId = user.id;
    switch (body.action) {
      case "set":
        return Response.json(await setResponsibleAdult({ eventId, attendeeId: body.attendeeId, adultPersonId: body.adultPersonId, reason: body.reason, actorUserId }));
      case "revoke":
        return Response.json(await revokeResponsibleAdult({ eventId, attendeeId: body.attendeeId, reason: body.reason, actorUserId }));
      case "dismiss":
        return Response.json(await dismissConflict({ eventId, conflictId: body.conflictId, reason: body.reason, actorUserId }));
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_GUARDIAN_AUTHORITY_REQUEST", message: error.issues[0]?.message ?? "Check the request and try again." }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof GuardianAuthorityError) {
      return Response.json({ error: error.code, message: error.message }, { status: statusFor(error) });
    }
    logError("Guardian authority request failed", error);
    return Response.json({ error: "GUARDIAN_AUTHORITY_FAILED", message: "The change could not be saved." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
