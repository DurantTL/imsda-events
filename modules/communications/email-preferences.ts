import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Announcement opt-outs (#838), the pure half.
 *
 * Only event announcements can be opted out of. Confirmations, receipts, waitlist and transfer notices, balance
 * reminders and safety or schedule-change notices always go, so nothing here applies to any other template.
 *
 * The preference lives on the normalised email address, so it follows the address across registrations and events.
 * An opt-out covers either one event's announcements or all IMSDA Events announcements.
 *
 * The unsubscribe link carries a signed token (HMAC-SHA256, keyed from the same secret as private registration
 * links but under its own domain prefix, so a token for one purpose is never valid for the other). It names an
 * address and an event and nothing else: no registration id, confirmation code, name, or amount. The address is in
 * the payload because it is the recipient's own and the page needs it to apply the choice; the page shows it masked.
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
// Signed tokens
// ---------------------------------------------------------------------------------------------------------------

const TOKEN_VERSION = "v1";
const MAX_TOKEN_LENGTH = 1024;

/** The secrets a token may be signed with, current first. The previous one only verifies, so a rotation is graceful. */
export function unsubscribeSigningSecrets(env: Record<string, string | undefined> = process.env): string[] {
  const configured = env.MANAGE_LINK_DERIVATION_SECRET?.trim();
  let current: string;
  if (configured && configured.length >= 32) {
    current = configured;
  } else if (env.NODE_ENV === "production") {
    throw new Error("MANAGE_LINK_DERIVATION_SECRET must contain at least 32 characters before unsubscribe links can be issued.");
  } else {
    current = "imsda-events-local-registration-link-secret-2026";
  }
  const previous = env.MANAGE_LINK_DERIVATION_SECRET_PREVIOUS?.trim();
  if (previous && previous.length < 32) {
    throw new Error("MANAGE_LINK_DERIVATION_SECRET_PREVIOUS must contain at least 32 characters when configured.");
  }
  return [...new Set([current, previous].filter((value): value is string => Boolean(value)))];
}

function sign(secret: string, payload: string) {
  return createHmac("sha256", secret).update(`imsda:announcement-unsubscribe:${TOKEN_VERSION}:${payload}`).digest("base64url");
}

export type UnsubscribeTokenSubject = { email: string; eventId: string };

export function createUnsubscribeToken(subject: UnsubscribeTokenSubject, secret = unsubscribeSigningSecrets()[0]) {
  const payload = Buffer.from(JSON.stringify({ e: normalizeEmailAddress(subject.email), v: subject.eventId }), "utf8").toString("base64url");
  return `${TOKEN_VERSION}.${payload}.${sign(secret, payload)}`;
}

/** The subject of a genuine token, or null for anything malformed, altered, or signed with an unknown secret. */
export function verifyUnsubscribeToken(
  token: string,
  secrets: readonly string[] = unsubscribeSigningSecrets(),
): UnsubscribeTokenSubject | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, payload, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const given = Buffer.from(signature);
  const genuine = secrets.some((secret) => {
    const expected = Buffer.from(sign(secret, payload));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!genuine) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { e?: unknown; v?: unknown };
    if (typeof decoded.e !== "string" || typeof decoded.v !== "string" || !decoded.e || !decoded.v) return null;
    if (decoded.e !== normalizeEmailAddress(decoded.e)) return null;
    return { email: decoded.e, eventId: decoded.v };
  } catch {
    return null;
  }
}

export function unsubscribePagePath(token: string) {
  return `/unsubscribe/${token}`;
}

/** The RFC 8058 endpoint: the List-Unsubscribe header's URL. A GET sends a person on to the page. */
export function unsubscribeApiPath(token: string) {
  return `/api/public/unsubscribe/${token}`;
}
