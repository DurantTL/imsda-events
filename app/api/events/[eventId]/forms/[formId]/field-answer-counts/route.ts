import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { countFieldAnswers } from "@/modules/forms/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const bodySchema = z.object({
  fieldKeys: z.array(z.string().trim().min(1)).min(1).max(20),
});

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: "INVALID_FIELD_KEYS", message: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  logError("Field answer count lookup failed", error);
  return Response.json({ error: "FIELD_ANSWER_COUNT_FAILED", message: "The answer counts could not be loaded." }, { status: 500 });
}

/**
 * Real submitted-answer counts for the registration builder's "review
 * before removing" dialog (#471), not for `formId` specifically — a field
 * key already covers an event, so `formId` only scopes the permission check
 * to the form the builder has open.
 */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string; formId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    const { fieldKeys } = bodySchema.parse(await request.json());
    const counts = await countFieldAnswers(eventId, fieldKeys);
    return Response.json({ counts });
  } catch (error) { return apiError(error); }
}

export const POST = withRequestContext(postHandler);
