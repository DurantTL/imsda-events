import QRCode from "qrcode";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { createDirectorClubPass } from "@/modules/checkin/club-pass-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { requireClubReportsAccess } from "@/modules/reporting/club-reports-access";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type Context = {
  params: Promise<{ eventId: string; organizationId: string }>;
};

function privateJson(body: unknown, init?: ResponseInit) {
  return Response.json(body, { ...init, headers: { ...privateHeaders, ...init?.headers } });
}

/**
 * The same club check-in QR the director sees (Q1, #412), rendered
 * server-side for staff so the club packet (#411) can print it without
 * weakening the director-only route: this one is gated on the club packet's
 * own event-scoped staff permission (report access, or Pathfinder
 * event-manager oversight of this club event, #387), never on roster access.
 */
async function getHandler(_request: Request, context: Context) {
  try {
    const { eventId, organizationId } = await context.params;
    await requireClubReportsAccess(await getCurrentSession(), eventId, findActiveMembership);

    const pass = await createDirectorClubPass(organizationId, eventId);
    if (!pass) {
      return privateJson({
        error: "CLUB_PASS_UNAVAILABLE",
        message: "This club QR pass is not available. Only a submitted or confirmed registration has one.",
      }, { status: 404 });
    }

    const svg = await QRCode.toString(pass.token, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
      color: { dark: "#003b5cff", light: "#ffffffff" },
    });
    return new Response(svg, {
      headers: {
        ...privateHeaders,
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Disposition": "inline; filename=\"imsda-club-pass.svg\"",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      const response = Response.json({ error: error.code, message: error.message }, { status: error.status });
      for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
      return response;
    }
    logError("Unable to render staff club pass QR", error);
    const response = Response.json({ error: "CLUB_PASS_QR_FAILED" }, { status: 500 });
    for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
    return response;
  }
}

export const GET = withRequestContext(getHandler);
