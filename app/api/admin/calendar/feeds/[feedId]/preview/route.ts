import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { calendarFeedApiError } from "@/modules/calendar/api-errors";
import { previewCalendarFeed } from "@/modules/calendar/feeds";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ feedId: string }> };

/** What an import would create, update and remove. Reads the feed; writes nothing. */
async function postHandler(request: Request, { params }: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    await requireSystemAdministrator();
    const { feedId } = await params;
    return Response.json({ preview: await previewCalendarFeed(feedId) });
  } catch (error) {
    return calendarFeedApiError(error, "Previewing an imported calendar");
  }
}

export const POST = withRequestContext(postHandler);
