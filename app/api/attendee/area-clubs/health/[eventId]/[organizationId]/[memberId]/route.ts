import { withRequestContext } from "@/lib/request-context";
import { requireAreaCoordinatorHealthViewer } from "@/modules/health-records/access";
import { healthApiError, healthDisabledResponse, healthJson } from "@/modules/health-records/api";
import { viewHealthRecord } from "@/modules/health-records/repository";

type RouteContext = { params: Promise<{ eventId: string; organizationId: string; memberId: string }> };

/**
 * An Area Coordinator opens the record of a member registered for an event,
 * inside that event's window, with a verified second sign-in step. View only;
 * the view is audited with the event id and member id.
 */
async function getHandler(_request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  try {
    const { eventId, organizationId, memberId } = await context.params;
    const viewer = await requireAreaCoordinatorHealthViewer();
    return healthJson({ health: await viewHealthRecord(viewer, organizationId, memberId, new Date(), { eventId }) });
  } catch (error) {
    return healthApiError(error, "Opening a health record");
  }
}

export const GET = withRequestContext(getHandler);
