import QRCode from "qrcode";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { createDirectorClubPass } from "@/modules/checkin/club-pass-repository";
import { withRequestContext } from "@/lib/request-context";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type Context = {
  params: Promise<{ organizationId: string; eventId: string }>;
};

function privateJson(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      ...privateHeaders,
      ...init?.headers,
    },
  });
}

/**
 * The club's own QR pass, for a director/deputy/registrar to show at
 * check-in (Q1, #412). Same roster access gate as the club event page —
 * a director from another club can never reach this organization's pass.
 */
async function getHandler(_request: Request, context: Context) {
  try {
    const { organizationId, eventId } = await context.params;
    await requireRosterAccess(organizationId);

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
      color: {
        dark: "#003b5cff",
        light: "#ffffffff",
      },
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
    // Errors are private too, so no shared cache keeps a 401 or 404.
    const response = rosterApiError(error, "Loading the club check-in QR");
    for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
    return response;
  }
}

export const GET = withRequestContext(getHandler);
