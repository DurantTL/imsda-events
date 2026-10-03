import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { calendarFeedApiError } from "@/modules/calendar/api-errors";
import { resetCalendarEntryToSource, setCalendarEntryHidden } from "@/modules/calendar/feeds";
import { calendarEntrySourceActionSchema } from "@/modules/calendar/schemas";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ entryId: string }> };

/** Hide or show an imported item here only, or reset it to the source's version. */
async function postHandler(request: Request, { params }: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { entryId } = await params;
    const { action } = calendarEntrySourceActionSchema.parse(await request.json());
    if (action === "reset") return Response.json(await resetCalendarEntryToSource(entryId, actor.id));
    return Response.json({ entries: await setCalendarEntryHidden(entryId, action === "hide", actor.id) });
  } catch (error) {
    return calendarFeedApiError(error, "Changing an imported item");
  }
}

export const POST = withRequestContext(postHandler);
