import { z } from "zod";
import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import {
  enqueueSelectedAudienceBatch,
  getSelectedAudiencePreview,
} from "@/modules/communications/messaging-repository";
import {
  selectedAudienceBatchInputSchema,
  selectedAudienceTemplateKeys,
} from "@/modules/communications/selected-audience";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

const previewRequestSchema = z.strictObject({
  templateKey: z.enum(selectedAudienceTemplateKeys),
  registrationIds: z.array(z.string().trim().min(1).max(64)).min(1).max(250),
});

async function authorize(eventId: string) {
  return requirePermission(
    await getCurrentSession(),
    eventId,
    "MANAGE_COMMUNICATIONS",
    findActiveMembership,
  );
}

/**
 * Preview is a POST because the audience is the request body: a chosen set of
 * up to 250 identifiers does not belong in a query string, where it would be
 * truncated by proxies and written into every access log.
 */
async function postHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await authorize(eventId);
    const body = await request.json();
    if (body?.mode === "preview") {
      const input = previewRequestSchema.parse({
        templateKey: body.templateKey,
        registrationIds: body.registrationIds,
      });
      return Response.json({
        selectedAudiencePreview: await getSelectedAudiencePreview(
          eventId,
          input.templateKey,
          input.registrationIds,
        ),
      });
    }
    const input = selectedAudienceBatchInputSchema.parse(body);
    const operation = await enqueueSelectedAudienceBatch(
      eventId,
      input,
      access.user.id,
    );
    return Response.json({ operation }, { status: 201 });
  } catch (error) {
    return messagingApiError(error, "Sending the message to the selected registrations");
  }
}

export const POST = withRequestContext(postHandler);
