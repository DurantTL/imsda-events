import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { calendarFeedApiError } from "@/modules/calendar/api-errors";
import { calendarFeedSyncSchema } from "@/modules/calendar/schemas";
import { listCalendarFeeds, syncCalendarFeed } from "@/modules/calendar/feeds";
import { listCalendarEntries } from "@/modules/calendar/repository";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ feedId: string }> };

/** Import (the first time) or Refresh now. Idempotent: an unchanged item writes nothing. */
async function postHandler(request: Request, { params }: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { feedId } = await params;
    // An optional body: only a staff member who has seen the preview's empty-feed warning sends allowEmpty.
    const { allowEmpty } = calendarFeedSyncSchema.parse(await request.json().catch(() => ({})));
    const summary = await syncCalendarFeed(feedId, { actorUserId: actor.id, allowEmpty: allowEmpty === true });
    return Response.json({ summary, feeds: await listCalendarFeeds(), entries: await listCalendarEntries() });
  } catch (error) {
    return calendarFeedApiError(error, "Importing a calendar");
  }
}

export const POST = withRequestContext(postHandler);
