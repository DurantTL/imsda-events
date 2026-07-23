import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { findActiveMembership } from "@/modules/events/repository";
import { requireProgramAssignmentAccess } from "@/modules/program-assignments/access";
import { programAssignmentRosterCsv } from "@/modules/program-assignments/domain";
import { getAppliedAssignmentRoster } from "@/modules/program-assignments/repository";

export async function GET(
  _request: Request,
  context: { params: Promise<{ eventId: string; runId: string }> },
) {
  try {
    const { eventId, runId } = await context.params;
    await requireProgramAssignmentAccess(
      await getCurrentSession(),
      eventId,
      findActiveMembership,
    );
    const roster = await getAppliedAssignmentRoster(eventId, runId);
    if (!roster) {
      return Response.json(
        {
          error: "RUN_NOT_FOUND",
          message: "That applied assignment run was not found for this event.",
        },
        { status: 404 },
      );
    }
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "run";
    return new Response(programAssignmentRosterCsv(roster), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="program-assignments-${safeRunId}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    console.error("Unable to export program assignment roster", error);
    return Response.json(
      { error: "PROGRAM_ASSIGNMENT_EXPORT_FAILED" },
      { status: 500 },
    );
  }
}
