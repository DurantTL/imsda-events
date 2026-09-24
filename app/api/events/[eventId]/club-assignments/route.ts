import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { requireClubAssignmentAccess } from "@/modules/club-registrations/assignments-access";
import { listClubAssignments } from "@/modules/club-registrations/assignments-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

function clubAssignmentsApiError(error: unknown, context: string) {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_REQUEST", message: error.issues[0]?.message ?? "Review the request.", issues: error.issues },
      { status: 400 },
    );
  }
  logError(`${context} failed`, error);
  return Response.json(
    { error: "CLUB_ASSIGNMENTS_REQUEST_FAILED", message: `${context} could not be completed.` },
    { status: 500 },
  );
}

async function getHandler(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await requireClubAssignmentAccess(await getCurrentSession(), eventId, findActiveMembership);
    const assignments = await listClubAssignments(eventId);
    return Response.json(
      { assignments },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return clubAssignmentsApiError(error, "Loading club assignments");
  }
}

export const GET = withRequestContext(getHandler);
