/**
 * Pure rules for attendee passkeys. Signature checks are never done here: the
 * WebAuthn library verifies every ceremony.
 */

/** How long a passkey prompt stays answerable. */
export const PASSKEY_CHALLENGE_MINUTES = 5;

/** How recently this session must have passed a second step to add or remove a passkey. */
export const PASSKEY_CHANGE_WINDOW_HOURS = 12;

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

/** Whether a session's last second-step check is recent enough to change passkeys. */
export function hasRecentSecondFactor(verifiedAt: Date | null | undefined, now: Date) {
  return Boolean(verifiedAt) && now.getTime() - verifiedAt!.getTime() <= PASSKEY_CHANGE_WINDOW_HOURS * 3_600_000;
}
