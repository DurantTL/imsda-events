import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import {
  enqueueBalanceReminderBatch,
  getBalanceReminderPreview,
  getMessagingWorkspace,
} from "@/modules/communications/messaging-repository";
import { balanceReminderBatchInputSchema } from "@/modules/communications/schemas";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

async function authorize(eventId: string) {
  return requirePermission(
    await getCurrentSession(),
    eventId,
    "MANAGE_COMMUNICATIONS",
    findActiveMembership,
  );
}

async function getHandler(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await authorize(eventId);
    const reminderPreview = await getBalanceReminderPreview(eventId);
    return Response.json({ reminderPreview });
  } catch (error) {
    return messagingApiError(error, "Refreshing the balance-reminder preview");
  }
}

async function postHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await authorize(eventId);
    const input = balanceReminderBatchInputSchema.parse(await request.json());
    const operation = await enqueueBalanceReminderBatch(
      eventId,
      input,
      access.user.id,
    );
    const messaging = await getMessagingWorkspace(eventId);
    return Response.json({ operation, messaging }, { status: 201 });
  } catch (error) {
    return messagingApiError(error, "Creating the balance-reminder batch");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
