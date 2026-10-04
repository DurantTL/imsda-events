import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  AttendanceReconciliationError,
  acknowledgeRosterReview,
  approveReconciliation,
  prepareReconciliation,
  recordAttendanceCorrection,
} from "@/modules/attendance-reconciliation/repository";
import { attendanceReconciliationActionSchema } from "@/modules/attendance-reconciliation/schemas";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Attendance reconciliation actions for a deferred-invoice event (#166): correct one person's
 * attendance (reason required), prepare a draft reconciliation, approve a draft. MANAGE_FINANCE on
 * the event in the URL, checked here; the service refuses any attendee or version that is not on
 * that event. Same-origin only. Nothing here finalizes or sends an invoice.
 */

type RouteContext = { params: Promise<{ eventId: string }> };

function statusFor(error: AttendanceReconciliationError) {
  switch (error.code) {
    case "EVENT_NOT_FOUND":
    case "ATTENDEE_NOT_FOUND":
    case "VERSION_NOT_FOUND":
    case "REGISTRATION_NOT_FOUND":
      return 404;
    default:
      return 409;
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const { user } = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const body = attendanceReconciliationActionSchema.parse(await request.json().catch(() => ({})));
    const actorUserId = user.id;
    switch (body.action) {
      case "prepare":
        return Response.json(await prepareReconciliation({ eventId, actorUserId }));
      case "approve":
        return Response.json(await approveReconciliation({ eventId, versionId: body.versionId, actorUserId }));
      case "acknowledge":
        return Response.json(await acknowledgeRosterReview({ eventId, registrationId: body.registrationId, reason: body.reason, actorUserId }));
      case "correct":
        return Response.json(await recordAttendanceCorrection({ eventId, attendeeId: body.attendeeId, kind: body.kind, reason: body.reason, actorUserId }));
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_ATTENDANCE_REQUEST", message: error.issues[0]?.message ?? "Check the request and try again." }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof AttendanceReconciliationError) {
      return Response.json({ error: error.code, message: error.message, blockers: error.blockers }, { status: statusFor(error) });
    }
    logError("Attendance reconciliation request failed", error);
    return Response.json({ error: "ATTENDANCE_RECONCILIATION_FAILED", message: "The change could not be saved." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
