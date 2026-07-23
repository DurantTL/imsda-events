import QRCode from "qrcode";
import {
  AccessDeniedError,
  requirePermission,
} from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { createStaffAttendeePass } from "@/modules/checkin/attendee-pass-repository";
import { findActiveMembership } from "@/modules/events/repository";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

type RouteContext = {
  params: Promise<{ eventId: string; attendeeId: string }>;
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

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { eventId, attendeeId } = await context.params;
    await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_CHECK_IN",
      findActiveMembership,
    );

    const pass = await createStaffAttendeePass(eventId, attendeeId);
    if (!pass) {
      return privateJson({
        error: "ATTENDEE_PASS_UNAVAILABLE",
        message: "This attendee pass is no longer available.",
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
        "Content-Disposition": "inline; filename=\"imsda-attendee-pass.svg\"",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return privateJson(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    console.error(
      "Staff attendee pass rendering failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return privateJson({
      error: "ATTENDEE_PASS_RENDER_FAILED",
      message: "The attendee pass could not be displayed. Try again.",
    }, { status: 500 });
  }
}
