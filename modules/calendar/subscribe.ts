/**
 * "Add this calendar to yours" links (#444), all built from the site's
 * canonical URL (`APP_BASE_URL`) so no host is hardcoded. The feed stays at
 * `/calendar/feed.ics` for existing subscribers.
 */

export const calendarFeedPath = "/calendar/feed.ics";
export const calendarFeedName = "IMSDA conference calendar";

/** The canonical site origin, without a trailing slash. */
export function siteBaseUrl() {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export type CalendarSubscribeLinks = {
  /** The https feed, for the plain link and the copy button. */
  feedUrl: string;
  /** The same feed with the webcal scheme, which opens the default calendar app. */
  webcalUrl: string;
  google: string;
  outlook: string;
  outlookWork: string;
  apple: string;
};

export function buildSubscribeLinks(baseUrl: string): CalendarSubscribeLinks {
  const feedUrl = `${baseUrl.replace(/\/+$/, "")}${calendarFeedPath}`;
  const webcalUrl = feedUrl.replace(/^https?:/i, "webcal:");
  const name = encodeURIComponent(calendarFeedName);
  const addFromWeb = `url=${encodeURIComponent(feedUrl)}&name=${name}`;
  return {
    feedUrl,
    webcalUrl,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?${addFromWeb}`,
    outlookWork: `https://outlook.office.com/calendar/0/addfromweb?${addFromWeb}`,
    apple: webcalUrl,
  };
}
