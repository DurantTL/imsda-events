import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { calendarFeedApiError } from "@/modules/calendar/api-errors";
import { createCalendarFeed, listCalendarFeeds } from "@/modules/calendar/feeds";
import { calendarFeedInputSchema } from "@/modules/calendar/schemas";
import { withRequestContext } from "@/lib/request-context";

/** Imported calendars (#444 part B). The saved address is never returned, only its hint. */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    return Response.json({ feeds: await listCalendarFeeds() });
  } catch (error) {
    return calendarFeedApiError(error, "Loading imported calendars");
  }
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const input = calendarFeedInputSchema.parse(await request.json());
    return Response.json({ feeds: await createCalendarFeed(input, actor.id) }, { status: 201 });
  } catch (error) {
    return calendarFeedApiError(error, "Adding an imported calendar");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
