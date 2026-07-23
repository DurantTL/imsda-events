import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import { updateMessagingSettings } from "@/modules/communications/messaging-repository";
import { messagingSettingsInputSchema } from "@/modules/communications/schemas";
import { findActiveMembership } from "@/modules/events/repository";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_COMMUNICATIONS",
      findActiveMembership,
    );
    const input = messagingSettingsInputSchema.parse(await request.json());
    const messaging = await updateMessagingSettings(eventId, input, access.user.id);
    return Response.json({ messaging });
  } catch (error) {
    return messagingApiError(error, "Updating message settings");
  }
}
