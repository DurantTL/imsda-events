import { withRequestContext } from "@/lib/request-context";
import { requireStaffHealthViewer } from "@/modules/health-records/access";
import { healthApiError, healthDisabledResponse, healthJson } from "@/modules/health-records/api";
import { viewHealthRecord } from "@/modules/health-records/repository";

type RouteContext = { params: Promise<{ organizationId: string; memberId: string }> };

/**
 * A system administrator, or staff holding VIEW_HEALTH_INFORMATION on an event
 * (then `?eventId=` names that event and the member must be one of its
 * attendees, inside its window). View only; every view is audited.
 */
async function getHandler(request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  try {
    const { organizationId, memberId } = await context.params;
    const viewer = await requireStaffHealthViewer();
    const eventId = new URL(request.url).searchParams.get("eventId") ?? undefined;
    return healthJson({ health: await viewHealthRecord(viewer, organizationId, memberId, new Date(), { eventId }) });
  } catch (error) {
    return healthApiError(error, "Opening a health record");
  }
}

export const GET = withRequestContext(getHandler);
