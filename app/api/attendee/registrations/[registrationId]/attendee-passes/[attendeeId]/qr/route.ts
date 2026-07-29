import QRCode from "qrcode";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { createAccountAttendeePass } from "@/modules/checkin/attendee-pass-repository";
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
  params: Promise<{ registrationId: string; attendeeId: string }>;
};

async function getHandler(_request: Request, context: Context) {
  try {
    const { account } = await getCurrentAttendee();
    if (!account) {
      return Response.json(
        { error: "SIGN_IN_REQUIRED", message: "Sign in to view an attendee pass." },
        { status: 401, headers: privateHeaders },
      );
    }
    const { registrationId, attendeeId } = await context.params;
    const pass = await createAccountAttendeePass(
      account.verifiedEmail,
      registrationId,
      attendeeId,
    );
    if (!pass) {
      return Response.json(
        { error: "ATTENDEE_PASS_UNAVAILABLE", message: "This attendee pass is unavailable." },
        { status: 404, headers: privateHeaders },
      );
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
        "Content-Disposition": "inline; filename=\"imsda-attendee-pass.svg\"",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logError("Account attendee pass rendering failed.", error);
    return Response.json(
      { error: "ATTENDEE_PASS_RENDER_FAILED", message: "The attendee pass could not be displayed." },
      { status: 500, headers: privateHeaders },
    );
  }
}

export const GET = withRequestContext(getHandler);
