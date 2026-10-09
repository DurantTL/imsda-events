import { createHash, createHmac } from "node:crypto";

/**
 * Announcement opt-outs (#838), the pure half.
 *
 * Only event announcements can be opted out of. Confirmations, receipts, waitlist and transfer notices, balance
 * reminders and safety or schedule-change notices always go, so nothing here applies to any other template.
 *
 * The preference lives on the normalised email address, so it follows the address across registrations and events.
 * An opt-out covers either one event's announcements or all IMSDA Events announcements.
 *
 * The unsubscribe link carries an opaque token: 32 bytes of HMAC-SHA256 output (keyed from the same secret as private
 * registration links, under its own domain prefix) and nothing readable. It holds no address, event, registration id or
 * name, so nothing sensitive reaches a request log, a path or a header. Which address and event it is for is recorded in
 * `EmailUnsubscribeToken`, by the token's hash, when the announcement is delivered; the link is looked up, so it also
 * keeps working after the signing secret is rotated. The page shows the address masked.
 */

export type AnnouncementOptOutScope = "EVENT" | "ALL";

export const ANNOUNCEMENT_OPT_OUT_TEMPLATE_KEY = "EVENT_ANNOUNCEMENT";

/** Only these template keys can be opted out of. Everything else is sent regardless. */
export function isOptOutEligibleTemplate(templateKey: string) {
  return templateKey === ANNOUNCEMENT_OPT_OUT_TEMPLATE_KEY;
}

export function normalizeEmailAddress(value: string) {
  return value.trim().toLowerCase();
}

/** `jo***@example.org`: enough for a person to recognise their own address, not enough to harvest it. */
export function maskEmailAddress(email: string) {
  const [local = "", domain = ""] = normalizeEmailAddress(email).split("@");
  if (!domain) return "***";
  const visible = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${visible}***@${domain}`;
}

export function optOutScopeKey(scope: AnnouncementOptOutScope, eventId: string) {
  return scope === "ALL" ? "ALL" : eventId;
}

export type AnnouncementOptOutRow = {
  normalizedEmail: string;
  scope: AnnouncementOptOutScope;
  eventId: string | null;
};

/**
 * The opt-out that applies to an address for one event's announcement, if any. A global opt-out is reported in
 * preference to an event one because it is the wider choice.
 */
export function announcementOptOutFor(
  rows: readonly AnnouncementOptOutRow[],
  email: string,
  eventId: string,
): AnnouncementOptOutScope | null {
  const normalized = normalizeEmailAddress(email);
  let match: AnnouncementOptOutScope | null = null;
  for (const row of rows) {
    if (row.normalizedEmail !== normalized) continue;
    if (row.scope === "ALL") return "ALL";
    if (row.scope === "EVENT" && row.eventId === eventId) match = "EVENT";
  }
  return match;
}

export const ANNOUNCEMENT_OPT_OUT_REASON = {
  EVENT: "Opted out of this event's announcements",
  ALL: "Opted out of all IMSDA Events announcements",
} as const satisfies Record<AnnouncementOptOutScope, string>;

/** Why a message was not sent, as recorded on the outbox row. */
export function announcementOptOutSkipMessage(scope: AnnouncementOptOutScope) {
  return `${ANNOUNCEMENT_OPT_OUT_REASON[scope]}; the announcement was not sent.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------------------------------------------

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The current signing secret. Rotating it only changes the tokens issued from then on; issued ones are looked up. */
export function unsubscribeSigningSecret(env: Record<string, string | undefined> = process.env): string {
  const configured = env.MANAGE_LINK_DERIVATION_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error("MANAGE_LINK_DERIVATION_SECRET must contain at least 32 characters before unsubscribe links can be issued.");
  }
  return "imsda-events-local-registration-link-secret-2026";
}

export type UnsubscribeTokenSubject = { email: string; eventId: string };

/**
 * The token for an address and an event: the same inputs always give the same token (so a retried delivery reuses its
 * row), and it cannot be computed without the secret. It is opaque; see `EmailUnsubscribeToken` for what it means.
 */
export function deriveUnsubscribeToken(subject: UnsubscribeTokenSubject, secret = unsubscribeSigningSecret()) {
  return createHmac("sha256", secret)
    .update(`imsda:announcement-unsubscribe:v2:${normalizeEmailAddress(subject.email)}\u0000${subject.eventId}`)
    .digest("base64url");
}

export function isWellFormedUnsubscribeToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

/** What is stored in place of a token. */
export function hashUnsubscribeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function unsubscribePagePath(token: string) {
  return `/unsubscribe/${token}`;
}

/** The RFC 8058 endpoint: the List-Unsubscribe header's URL. A GET sends a person on to the page. */
export function unsubscribeApiPath(token: string) {
  return `/api/public/unsubscribe/${token}`;
}

/**
 * Gmail and Yahoo only honour an https one-click URL. In production a base URL that is not https therefore sends no
 * List-Unsubscribe headers (the body link still works); elsewhere, such as local development, they are sent anyway so
 * the headers can be seen.
 */
export function unsubscribeHeadersAllowed(baseUrl: string, nodeEnv: string | undefined) {
  return new URL(baseUrl).protocol === "https:" || nodeEnv !== "production";
}
