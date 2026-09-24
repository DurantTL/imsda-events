import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubAssignmentAccess } from "@/modules/club-registrations/assignments-access";
import {
  ClubAssignmentError,
  clubAssignmentInputSchema,
  upsertClubAssignment,
} from "@/modules/club-registrations/assignments-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

function clubAssignmentApiError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ClubAssignmentError) {
    return Response.json({ error: error.code, message: error.message }, { status: 404 });
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_ASSIGNMENT", message: error.issues[0]?.message ?? "Review the assignment.", issues: error.issues },
      { status: 400 },
    );
  }
  logError("Club assignment update failed", error);
  return Response.json(
    { error: "CLUB_ASSIGNMENT_UPDATE_FAILED", message: "The club assignment could not be saved." },
    { status: 500 },
  );
}

async function putHandler(
  request: Request,
  context: { params: Promise<{ eventId: string; organizationId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, organizationId } = await context.params;
    const access = await requireClubAssignmentAccess(await getCurrentSession(), eventId, findActiveMembership);
    const input = clubAssignmentInputSchema.parse(await request.json());
    const saved = await upsertClubAssignment(eventId, organizationId, input, access.user.id);
    return Response.json({
      assignment: {
        version: saved.version,
        lastEmailSentAt: saved.lastEmailSentAt?.toISOString() ?? null,
        lastEmailedVersion: saved.lastEmailedVersion,
      },
    });
  } catch (error) {
    return clubAssignmentApiError(error);
  }
}

export const PUT = withRequestContext(putHandler);
