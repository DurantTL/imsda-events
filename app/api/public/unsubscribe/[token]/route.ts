import { withRequestContext } from "@/lib/request-context";
import {
  removeAnnouncementOptOuts,
  recordAnnouncementOptOut,
  resolveUnsubscribeToken,
} from "@/modules/communications/email-preferences-repository";
import { unsubscribePagePath } from "@/modules/communications/email-preferences";

/**
 * The unsubscribe endpoint (#838), used two ways:
 *
 * - RFC 8058 one-click: a mail client POSTs `List-Unsubscribe=One-Click` to the URL in the `List-Unsubscribe`
 *   header. There is no login, no cookie and no CSRF token, so the only thing that authorises it is the signed token
 *   in the URL, which names exactly one address and one event. It opts that address out of that event's
 *   announcements and nothing else.
 * - The confirmation page's buttons POST `action=event|all|resubscribe`, then are sent back to the page.
 *
 * A GET never changes anything (link scanners and previews fetch URLs): it checks the token and sends a person on to the
 * page. The token is opaque and looked up (it holds no address); an unknown or altered one is a 404 with no detail, so
 * the endpoint cannot be used to learn anything. The body is read with `formData()`, so urlencoded and multipart
 * submissions both work, as RFC 8058 allows either.
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
  if (!(await resolveUnsubscribeToken(token))) return notFound();
  return redirectToPage(token);
}

async function postHandler(request: Request, context: Context) {
  const { token } = await context.params;
  const subject = await resolveUnsubscribeToken(token);
  if (!subject) return notFound();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Bad request", { status: 400, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" } });
  }
  const rawAction = form.get("action");
  const action = typeof rawAction === "string" ? rawAction : null;

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
