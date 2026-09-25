/**
 * Pure WebAuthn rules shared by every principal that has passkeys (attendees
 * in `modules/attendee-accounts/`, staff in `modules/access/`). Signature
 * checks are never done here: the WebAuthn library verifies every ceremony.
 *
 * Anything that depends on which principal is signing in (session shape,
 * database tables, what "recently verified" means for that account) stays in
 * that principal's own module instead of here.
 */

/** How long a passkey prompt stays answerable. */
export const PASSKEY_CHALLENGE_MINUTES = 5;

const hostnamePattern = /^(localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/;

export function isValidRelyingPartyId(value: string) {
  return value.length <= 253 && hostnamePattern.test(value);
}

/**
 * The origin a ceremony must come from, or null when passkeys can't be used
 * here. The page's host must be the configured RP ID or a subdomain of it,
 * over HTTPS (plain HTTP only for localhost, as browsers themselves require).
 */
export function matchRelyingParty(rpId: string | null | undefined, requestOrigin: string | null | undefined) {
  if (!rpId || !requestOrigin || !isValidRelyingPartyId(rpId)) return null;
  let url: URL;
  try {
    url = new URL(requestOrigin);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
  const hostMatches = url.hostname === rpId || url.hostname.endsWith(`.${rpId}`);
  if (!secure || !hostMatches) return null;
  return { rpId, origin: url.origin };
}

export function passkeyNameFrom(value: unknown) {
  const name = typeof value === "string" ? value.trim().slice(0, 60) : "";
  return name || "Passkey";
}
