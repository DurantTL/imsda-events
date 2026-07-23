import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import { createLocalTestMessage } from "@/modules/communications/messaging-repository";
import { messageTestInputSchema } from "@/modules/communications/schemas";
import { findActiveMembership } from "@/modules/events/repository";

export async function POST(
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
    const input = messageTestInputSchema.parse(await request.json());
    const messaging = await createLocalTestMessage(
      eventId,
      templateId,
      input,
      access.user.id,
    );
    return Response.json({ messaging }, { status: 201 });
  } catch (error) {
    return messagingApiError(error, "Creating the local test message");
  }
}
