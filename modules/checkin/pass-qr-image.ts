import QRCode from "qrcode";

/**
 * How an attendee pass is drawn. One definition, used by the pass route (SVG for the page, PNG for a mail client
 * that fetches a link) and by email delivery, which renders the PNG itself and embeds it in the message so a
 * client shows it without "download pictures" and without a request back to this app.
 */
export const ATTENDEE_PASS_QR_OPTIONS = {
  errorCorrectionLevel: "M" as const,
  margin: 2,
  width: 280,
  color: {
    dark: "#003b5cff",
    light: "#ffffffff",
  },
};

export async function renderAttendeePassQrPng(passToken: string) {
  return QRCode.toBuffer(passToken, { type: "png", ...ATTENDEE_PASS_QR_OPTIONS });
}

export async function renderAttendeePassQrSvg(passToken: string) {
  return QRCode.toString(passToken, { type: "svg", ...ATTENDEE_PASS_QR_OPTIONS });
}
