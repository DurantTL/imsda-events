import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import { sendTestMessage } from "@/modules/communications/messaging-repository";
import { messageTestInputSchema } from "@/modules/communications/schemas";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(
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
    const messaging = await sendTestMessage(
      eventId,
      templateId,
      input,
      access.user.id,
    );
    return Response.json({ messaging }, { status: 201 });
  } catch (error) {
    return messagingApiError(error, "Sending the test message");
  }
}

export const POST = withRequestContext(postHandler);
