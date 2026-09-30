import { safeReturnTo } from "@/lib/return-to";

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The club's own registration page for one event, the only place the roster may send someone back to (#643). */
export function clubRegistrationPath(organizationId: string, eventId: string): string {
  return `/account/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}`;
}

/** The club roster page, carrying a `returnTo` back to this event's registration. */
export function rosterHrefFromRegistration(organizationId: string, eventId: string): string {
  return `/account/clubs/${encodeURIComponent(organizationId)}/roster?returnTo=${encodeURIComponent(clubRegistrationPath(organizationId, eventId))}`;
}

/**
 * Validates a roster page `returnTo`: only this same club's registration page
 * (`/account/clubs/{organizationId}/events/{eventId}`) is accepted. Anything
 * else (another club, another section, extra path, query, or fragment, or an
 * unsafe URL) returns null so the page shows no link.
 */
export function registrationReturnTo(organizationId: string, raw: string | string[] | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  if (safeReturnTo(raw, "") === "") return null;
  const parts = raw.split("/");
  // ["", "account", "clubs", orgId, "events", eventId]
  if (parts.length !== 6) return null;
  if (parts[0] !== "" || parts[1] !== "account" || parts[2] !== "clubs" || parts[4] !== "events") return null;
  if (parts[3] !== organizationId || !SEGMENT.test(parts[3]!)) return null;
  if (!SEGMENT.test(parts[5]!)) return null;
  return raw;
}
