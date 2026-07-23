import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import { publishMessageTemplateVersion } from "@/modules/communications/messaging-repository";
import { messageTemplateInputSchema } from "@/modules/communications/schemas";
import { findActiveMembership } from "@/modules/events/repository";

export async function PUT(
  request: Request,
  context: { params: Promise<{ eventId: string; templateId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, templateId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_COMMUNICATIONS",
      findActiveMembership,
    );
    const input = messageTemplateInputSchema.parse(await request.json());
    const messaging = await publishMessageTemplateVersion(
      eventId,
      templateId,
      input,
      access.user.id,
    );
    return Response.json({ messaging });
  } catch (error) {
    return messagingApiError(error, "Publishing the message template");
  }
}
