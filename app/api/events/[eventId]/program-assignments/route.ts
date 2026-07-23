import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { requireProgramAssignmentAccess } from "@/modules/program-assignments/access";
import {
  applyProgramAssignments,
  getProgramAssignmentPreview,
  ProgramAssignmentError,
} from "@/modules/program-assignments/repository";
import {
  applyProgramAssignmentsSchema,
  programAssignmentSelectionSchema,
} from "@/modules/program-assignments/schemas";

function programAssignmentApiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json(
      {
        error: "INVALID_ASSIGNMENT_REQUEST",
        message: error.issues[0]?.message ?? "Review the assignment request.",
        issues: error.issues,
      },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  if (error instanceof ProgramAssignmentError) {
    const status = error.code.endsWith("NOT_FOUND") ? 404 : 409;
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status },
    );
  }
  console.error("Program assignment request failed", error);
  return Response.json(
    {
      error: "PROGRAM_ASSIGNMENT_REQUEST_FAILED",
      message: "The program assignment request could not be completed.",
    },
    { status: 500 },
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await requireProgramAssignmentAccess(
      await getCurrentSession(),
      eventId,
      findActiveMembership,
    );
    const search = new URL(request.url).searchParams;
    const selection = programAssignmentSelectionSchema.parse({
      formVersionId: search.get("formVersionId"),
      fieldId: search.get("fieldId"),
    });
    const preview = await getProgramAssignmentPreview(eventId, selection);
    return Response.json(
      { preview },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return programAssignmentApiError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requireProgramAssignmentAccess(
      await getCurrentSession(),
      eventId,
      findActiveMembership,
    );
    const input = applyProgramAssignmentsSchema.parse(await request.json());
    const run = await applyProgramAssignments(eventId, input, access.user.id);
    return Response.json(
      { run },
      {
        status: 201,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  } catch (error) {
    return programAssignmentApiError(error);
  }
}
