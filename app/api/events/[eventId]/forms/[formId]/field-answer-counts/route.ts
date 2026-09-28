import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { FIELD_ANSWER_COUNT_BATCH_SIZE } from "@/modules/forms/field-answer-counts";
import { countFieldAnswers, formBelongsToEvent } from "@/modules/forms/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

// Keys are taken exactly as stored, never trimmed, so a count always matches
// the field it names.
const bodySchema = z.object({
  fieldKeys: z.array(z.string().min(1).max(200)).min(1).max(FIELD_ANSWER_COUNT_BATCH_SIZE),
});

class MalformedBodyError extends Error {}

function apiError(error: unknown) {
  if (error instanceof MalformedBodyError) {
    return Response.json({ error: "INVALID_REQUEST_BODY", message: "The request body must be valid JSON." }, { status: 400 });
  }
  if (error instanceof z.ZodError) {
    return Response.json({ error: "INVALID_FIELD_KEYS", message: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  logError("Field answer count lookup failed", error);
  return Response.json({ error: "FIELD_ANSWER_COUNT_FAILED", message: "The answer counts could not be loaded." }, { status: 500 });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new MalformedBodyError();
  }
}

/**
 * Real submitted-answer counts, per registration, for the registration
 * builder's "review before removing" dialog (#471). A field key already
 * covers the whole event, but `formId` must still be one of this event's
 * forms: another event's form id is a 404.
 */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string; formId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, formId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_FORMS", findActiveMembership);
    if (!(await formBelongsToEvent(eventId, formId))) {
      return Response.json({ error: "FORM_NOT_FOUND", message: "That registration form no longer exists." }, { status: 404 });
    }
    const { fieldKeys } = bodySchema.parse(await readJson(request));
    const counts = await countFieldAnswers(eventId, fieldKeys);
    return Response.json({ counts });
  } catch (error) { return apiError(error); }
}

export const POST = withRequestContext(postHandler);
