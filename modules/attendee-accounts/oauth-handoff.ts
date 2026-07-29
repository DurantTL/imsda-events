import { timingSafeEqual } from "node:crypto";

/**
 * The short-lived state carried between starting a Google sign-in and coming
 * back from it. Pure, so the checks that decide whether a callback is genuine
 * can be tested without a browser or a network.
 */

/**
 * Long enough to choose an account and type a Google password, short enough
 * that an abandoned attempt does not stay spendable.
 */
export const OAUTH_HANDOFF_LIFETIME_SECONDS = 10 * 60;

export type OAuthHandoff = {
  state: string;
  nonce: string;
  codeVerifier: string;
};

/**
 * Reads the cookie written at the start of the flow. Anything malformed is
 * simply absent — a caller cannot act on half of one.
 */
export function parseOAuthHandoff(raw: string | undefined): OAuthHandoff | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthHandoff>;
    if (
      typeof parsed.state !== "string" || !parsed.state
      || typeof parsed.nonce !== "string" || !parsed.nonce
      || typeof parsed.codeVerifier !== "string" || !parsed.codeVerifier
    ) {
      return null;
    }
    return { state: parsed.state, nonce: parsed.nonce, codeVerifier: parsed.codeVerifier };
  } catch {
    return null;
  }
}

/**
 * Compares the `state` Google sent back with the one this browser was given.
 *
 * This is what makes the callback belong to a request someone here actually
 * made. Without it, an attacker can complete their own sign-in in a victim's
 * browser and leave the victim signed in as them — which sounds harmless until
 * the victim adds a registration to it.
 */
export function stateMatches(returned: string | null, expected: string) {
  if (!returned) return false;
  const a = Buffer.from(returned, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A redirect whose headers can still be written to.
 *
 * `Response.redirect()` returns a response with an immutable header guard, so
 * attaching the `RateLimit-*` headers to one throws — and throwing inside a
 * catch block that itself builds a redirect turns a handled failure into a 500.
 * This is the whole OAuth flow's redirect, for that reason.
 */
export function mutableRedirect(location: string | URL, status: 302 | 303 = 303) {
  return new Response(null, { status, headers: { Location: String(location) } });
}
