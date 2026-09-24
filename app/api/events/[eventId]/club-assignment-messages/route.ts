import { requireClubAssignmentMessageAccess } from "@/modules/club-registrations/assignments-access";
import { messagingApiError } from "@/modules/communications/api-errors";
import {
  enqueueClubAssignmentBatch,
  getClubAssignmentMessagePreview,
  getMessagingWorkspace,
} from "@/modules/communications/messaging-repository";
import { clubAssignmentBatchInputSchema } from "@/modules/communications/schemas";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { withRequestContext } from "@/lib/request-context";

async function authorize(eventId: string) {
  return requireClubAssignmentMessageAccess(await getCurrentSession(), eventId, findActiveMembership);
}

async function getHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await authorize(eventId);
    const search = new URL(request.url).searchParams;
    const scope = search.get("scope") === "ONE" ? "ONE" as const : "ALL_SET" as const;
    const organizationId = search.get("organizationId") ?? "";
    const preview = await getClubAssignmentMessagePreview(
      eventId,
      scope === "ONE" ? { scope, organizationId } : { scope },
    );
    return Response.json({ clubAssignmentPreview: preview });
  } catch (error) {
    return messagingApiError(error, "Refreshing the club assignments preview");
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
    const input = clubAssignmentBatchInputSchema.parse(await request.json());
    const operation = await enqueueClubAssignmentBatch(eventId, input, access.user.id);
    const messaging = await getMessagingWorkspace(eventId);
    return Response.json({ operation, messaging }, { status: 201 });
  } catch (error) {
    return messagingApiError(error, "Creating the club assignments batch");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
