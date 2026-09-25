/**
 * Name and lifetime of the cookie that remembers which event a multi-event
 * staff account looked at most recently (#108 queue 1 — role-aware
 * post-login routing).
 *
 * `proxy.ts` writes this cookie whenever a workspace request carries a
 * known `?event=` id; `readLastUsedEventId` (in `last-used-event.ts`) reads
 * it back at login time. Kept in its own dependency-free module so `proxy.ts`
 * — which cannot import `next/headers` or `server-only` code — and ordinary
 * server code can both use the same name and lifetime.
 *
 * The cookie is only ever a hint: it never grants access on its own.
 * `resolveLoginDestination` uses it only when it matches one of the signed-in
 * account's real active event memberships, and every workspace page still
 * authorizes the chosen event through `resolveEventContext`.
 */
export const LAST_USED_EVENT_COOKIE_NAME = "imsda-last-event";

/** Roughly six months. */
export const LAST_USED_EVENT_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
