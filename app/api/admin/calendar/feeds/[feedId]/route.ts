import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { calendarFeedApiError } from "@/modules/calendar/api-errors";
import { deleteCalendarFeed, updateCalendarFeed } from "@/modules/calendar/feeds";
import { calendarFeedUpdateSchema } from "@/modules/calendar/schemas";
import { listCalendarEntries } from "@/modules/calendar/repository";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ feedId: string }> };

async function patchHandler(request: Request, { params }: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { feedId } = await params;
    const input = calendarFeedUpdateSchema.parse(await request.json());
    return Response.json({ feeds: await updateCalendarFeed(feedId, input, actor.id) });
  } catch (error) {
    return calendarFeedApiError(error, "Updating an imported calendar");
  }
}

/** Deleting a feed keeps what it imported; the entries stay as ordinary items. */
async function deleteHandler(request: Request, { params }: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { feedId } = await params;
    const feeds = await deleteCalendarFeed(feedId, actor.id);
    return Response.json({ feeds, entries: await listCalendarEntries() });
  } catch (error) {
    return calendarFeedApiError(error, "Removing an imported calendar");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
