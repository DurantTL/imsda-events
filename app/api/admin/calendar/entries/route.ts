import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { calendarApiError } from "@/modules/calendar/api-errors";
import { createCalendarEntry, listCalendarEntries } from "@/modules/calendar/repository";
import { calendarEntryInputSchema } from "@/modules/calendar/schemas";
import { withRequestContext } from "@/lib/request-context";

async function getHandler() {
  try {
    await requireSystemAdministrator();
    return Response.json({ entries: await listCalendarEntries() });
  } catch (error) {
    return calendarApiError(error, "Loading calendar entries");
  }
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const input = calendarEntryInputSchema.parse(await request.json());
    return Response.json({ entries: await createCalendarEntry(input, actor.id) }, { status: 201 });
  } catch (error) {
    return calendarApiError(error, "Adding a calendar entry");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
