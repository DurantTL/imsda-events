import { withRequestContext } from "@/lib/request-context";
import {
  removeAnnouncementOptOuts,
  recordAnnouncementOptOut,
} from "@/modules/communications/email-preferences-repository";
import {
  unsubscribePagePath,
  verifyUnsubscribeToken,
} from "@/modules/communications/email-preferences";

/**
 * The unsubscribe endpoint (#838), used two ways:
 *
 * - RFC 8058 one-click: a mail client POSTs `List-Unsubscribe=One-Click` to the URL in the `List-Unsubscribe`
 *   header. There is no login, no cookie and no CSRF token, so the only thing that authorises it is the signed token
 *   in the URL, which names exactly one address and one event. It opts that address out of that event's
 *   announcements and nothing else.
 * - The confirmation page's buttons POST `action=event|all|resubscribe`, then are sent back to the page.
 *
 * A GET never changes anything (link scanners and previews fetch URLs): it only sends a person on to the page. An
 * altered or unknown token is a 404 with no detail, so the endpoint cannot be used to learn anything.
 */

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type Context = { params: Promise<{ token: string }> };

function notFound() {
  return new Response("Not found", { status: 404, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}

function redirectToPage(token: string, done?: string) {
  const location = `${unsubscribePagePath(token)}${done ? `?done=${done}` : ""}`;
  return new Response(null, { status: 303, headers: { ...privateHeaders, Location: location } });
}

async function getHandler(_request: Request, context: Context) {
  const { token } = await context.params;
  return redirectToPage(token);
}

async function postHandler(request: Request, context: Context) {
  const { token } = await context.params;
  const subject = verifyUnsubscribeToken(token);
  if (!subject) return notFound();

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return new Response("Bad request", { status: 400, headers: privateHeaders });
  }
  const action = form.get("action");

  if (action === null) {
    // RFC 8058: the body is exactly `List-Unsubscribe=One-Click`.
    if (form.get("List-Unsubscribe") !== "One-Click") {
      return new Response("Bad request", { status: 400, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" } });
    }
    await recordAnnouncementOptOut({ email: subject.email, eventId: subject.eventId, scope: "EVENT", source: "ONE_CLICK" });
    return new Response("Unsubscribed", { status: 200, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (action === "event" || action === "all") {
    await recordAnnouncementOptOut({
      email: subject.email,
      eventId: subject.eventId,
      scope: action === "all" ? "ALL" : "EVENT",
      source: "UNSUBSCRIBE_PAGE",
    });
    return redirectToPage(token, action);
  }
  if (action === "resubscribe") {
    await removeAnnouncementOptOuts({ email: subject.email, eventId: subject.eventId });
    return redirectToPage(token, "resubscribed");
  }
  return new Response("Bad request", { status: 400, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
