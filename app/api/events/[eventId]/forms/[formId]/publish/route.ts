import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { FormOperationError, publishRegistrationForm } from "@/modules/forms/repository";

function apiError(error: unknown) {
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof FormOperationError) {
    const status = error.code === "FORM_NOT_FOUND" ? 404 : error.code === "TEST_REQUIRED" ? 422 : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  console.error("Registration form publish failed", error);
  return Response.json({ error: "FORM_PUBLISH_FAILED", message: "The registration form could not be published." }, { status: 500 });
}

export async function POST(request: Request, context: { params: Promise<{ eventId: string; formId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, formId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    return Response.json({ form: await publishRegistrationForm(eventId, formId, access.user.id) });
  } catch (error) { return apiError(error); }
}
