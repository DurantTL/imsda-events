import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { messagingApiError } from "@/modules/communications/api-errors";
import { getMessagingWorkspace } from "@/modules/communications/messaging-repository";
import {
  previewFailedMessagesRetry,
  retryFailedMessages,
} from "@/modules/communications/retry-failed";
import {
  failedMessagesRetryInputSchema,
  failedMessagesRetryScopeSchema,
} from "@/modules/communications/schemas";
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

/** The preview staff confirm: `?batchId=...` for one send batch, otherwise every failed message of the event. */
async function getHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await authorize(eventId);
    const params = new URL(request.url).searchParams;
    const batchId = params.get("batchId");
    // `?scope=latest` opens on the newest failed batch (the safest default); with no batch it falls back to the event.
    const scope = params.get("scope") === "latest" && !batchId
      ? { type: "LATEST_BATCH" as const }
      : failedMessagesRetryScopeSchema.parse(
        batchId ? { type: "BATCH", batchId } : { type: "EVENT" },
      );
    const preview = await previewFailedMessagesRetry(eventId, scope);
    return Response.json({ preview });
  } catch (error) {
    return messagingApiError(error, "Previewing the failed messages");
  }
}

/** Queues the retry copies. Nothing is sent in this request: the outbox worker delivers them in batches. */
async function postHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await authorize(eventId);
    const input = failedMessagesRetryInputSchema.parse(await request.json());
    const operation = await retryFailedMessages(eventId, input, access.user.id);
    const messaging = await getMessagingWorkspace(eventId);
    return Response.json(
      { operation, messaging },
      { status: operation.replayed ? 200 : 201 },
    );
  } catch (error) {
    return messagingApiError(error, "Retrying the failed messages");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
