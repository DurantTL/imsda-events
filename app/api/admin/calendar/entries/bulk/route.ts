import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { calendarApiError } from "@/modules/calendar/api-errors";
import { bulkUpdateCalendarEntries } from "@/modules/calendar/repository";
import { calendarBulkSchema } from "@/modules/calendar/schemas";
import { withRequestContext } from "@/lib/request-context";

/** Set a category, publish/unpublish, or hide/unhide many entries at once (#796). */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const input = calendarBulkSchema.parse(await request.json());
    return Response.json(await bulkUpdateCalendarEntries(input, actor.id));
  } catch (error) {
    return calendarApiError(error, "Changing calendar entries");
  }
}

export const POST = withRequestContext(postHandler);
