import { addDays, buildCalendarIcs } from "@/modules/calendar/domain";
import { conferenceToday, listPublicCalendarItems } from "@/modules/calendar/repository";
import { siteBaseUrl } from "@/modules/calendar/subscribe";
import { withRequestContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/** The public calendar as a subscribable iCalendar feed: the last two months and the next eighteen. */
async function getHandler() {
  const now = new Date();
  const today = conferenceToday(now);
  const items = await listPublicCalendarItems(addDays(today, -60), addDays(today, 548), now, { expandRepeats: false });
  const body = buildCalendarIcs(items, { baseUrl: siteBaseUrl(), now });
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="imsda-calendar.ics"',
      "Cache-Control": "public, max-age=900",
    },
  });
}

export const GET = withRequestContext(getHandler);
