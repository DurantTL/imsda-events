/**
 * The one rule for a bare check-in link (#824), shared by the body editor's warning and the send check (#836) so the
 * two can never disagree about what counts as "alone".
 */

const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*\]\([^)]*\)/g;

/**
 * True when `{{checkin_qr_url}}` appears outside a Markdown link. The token is
 * a page link, so on its own it prints the web address in the email instead of
 * showing a QR code. Written as [text]({{checkin_qr_url}}) it is a button, and
 * the QR code itself is the `checkin_qr_image` token.
 */
export function hasStandaloneCheckinQrUrl(source: string) {
  return /\{\{\s*checkin_qr_url\s*\}\}/.test(source.replace(MARKDOWN_LINK_PATTERN, ""));
}
