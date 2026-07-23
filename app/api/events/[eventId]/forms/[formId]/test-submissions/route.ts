import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { testSubmissionSchema } from "@/modules/forms/definition";
import { createTestSubmission, FormOperationError } from "@/modules/forms/repository";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_TEST_SUBMISSION", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof FormOperationError) return Response.json({ error: error.code, message: error.message }, { status: 404 });
  console.error("Registration form test submission failed", error);
  return Response.json({ error: "TEST_SUBMISSION_FAILED", message: "The test submission could not be saved." }, { status: 500 });
}

export async function POST(request: Request, context: { params: Promise<{ eventId: string; formId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, formId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    const input = testSubmissionSchema.parse(await request.json());
    return Response.json({ submission: await createTestSubmission(eventId, formId, access.user.id, input) }, { status: 201 });
  } catch (error) { return apiError(error); }
}
