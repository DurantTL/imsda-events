/**
 * Name, lifetime, and value format of the cookie that remembers which event a
 * multi-event staff account last picked (#108 queue 1 — role-aware post-login
 * routing).
 *
 * The cookie is written only by `POST /api/staff/last-event`, after that route
 * has confirmed the signed-in account can open the event, and read back at
 * sign-in by `readLastUsedEventId` (in `last-used-event.ts`). Kept in its own
 * dependency-free module so the route, the reader, and tests share one
 * definition.
 *
 * The cookie is only ever a hint: it never grants access on its own.
 * `resolveLoginDestination` uses it only when it matches one of the signed-in
 * account's real active event memberships, and every workspace page still
 * authorizes the chosen event through `resolveEventContext`.
 */
export const LAST_USED_EVENT_COOKIE_NAME = "imsda-last-event";

/** Sixty days. */
export const LAST_USED_EVENT_COOKIE_MAX_AGE_SECONDS = 60 * 24 * 60 * 60;

/**
 * Event ids are Prisma cuids in production. The synthetic seed uses short
 * readable ids such as `evt_wr26`, so the check is the same conservative
 * identifier shape the event overview route accepts rather than a strict cuid
 * pattern: letters, digits, `_` and `-`, 3–64 characters.
 */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

export function isEventIdFormat(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}
