import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { calendarApiError } from "@/modules/calendar/api-errors";
import { deleteCalendarEntry, updateCalendarEntry } from "@/modules/calendar/repository";
import { calendarEntryUpdateSchema } from "@/modules/calendar/schemas";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ entryId: string }> };

async function patchHandler(request: Request, { params }: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { entryId } = await params;
    const input = calendarEntryUpdateSchema.parse(await request.json());
    return Response.json({ entries: await updateCalendarEntry(entryId, input, actor.id) });
  } catch (error) {
    return calendarApiError(error, "Updating a calendar entry");
  }
}

async function deleteHandler(request: Request, { params }: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { entryId } = await params;
    return Response.json({ entries: await deleteCalendarEntry(entryId, actor.id) });
  } catch (error) {
    return calendarApiError(error, "Removing a calendar entry");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
