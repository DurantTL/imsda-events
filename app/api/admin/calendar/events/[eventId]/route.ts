import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { calendarApiError } from "@/modules/calendar/api-errors";
import { updateEventCalendarSettings } from "@/modules/calendar/repository";
import { calendarEventSettingsSchema } from "@/modules/calendar/schemas";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ eventId: string }> };

async function patchHandler(request: Request, { params }: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { eventId } = await params;
    const input = calendarEventSettingsSchema.parse(await request.json());
    return Response.json({ events: await updateEventCalendarSettings(eventId, input, actor.id) });
  } catch (error) {
    return calendarApiError(error, "Updating the event's calendar settings");
  }
}

export const PATCH = withRequestContext(patchHandler);
