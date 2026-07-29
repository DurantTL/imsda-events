import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The emailed six-digit codes an attendee account uses — to verify an address at
 * sign-up, and later to authorise an edit.
 *
 * **Why a code rather than a link.** A link in an inbox is a bearer token: it
 * works for whoever opens it, survives forwarding, and is followed by mail
 * scanners. A code has to be carried back into the session that asked for it,
 * which binds the act to the person performing it (ADR 0003).
 *
 * That reasoning is what makes verification a code too, not only editing. The
 * attack a link permits at sign-up is specific and real: someone signs up as
 * `victim@example.com`, the victim receives an unexpected email, clicks the link
 * to see what it is, and has just verified the attacker's account onto their own
 * registrations. A code cannot be spent by the person who merely reads it.
 *
 * **Why a plain digest is enough for six digits.** A code is stored as
 * `sha256(code)`, which is trivially reversible for a value with a million
 * possibilities. It does not have to resist that, because the digest is never
 * the only half: spending a code also requires the opaque token held by the
 * browser that requested it, and that token is stored only as a hash. Someone
 * holding the entire database can recover a code and still cannot use it.
 * What guards the code against the person who *does* hold the token — whoever
 * started the sign-up — is the attempt ceiling and the rate limit, not the digest.
 */

export const ONE_TIME_CODE_DIGITS = 6;

/** How many wrong guesses a single issued code tolerates before it is spent. */
export const ONE_TIME_CODE_MAX_ATTEMPTS = 5;

/**
 * Short, because the person asking for it is looking at their inbox now. Long
 * enough to survive a slow mail hop and a search for the message.
 */
export const EMAIL_VERIFICATION_LIFETIME_MINUTES = 20;

/**
 * How long the browser handle may wait for a queued message to be prepared.
 *
 * This is deliberately longer than the code lifetime. The handle grants
 * nothing without the emailed code, while expiring it after twenty minutes
 * would make a code delivered after a slow queue unusable on arrival.
 */
export const ATTENDEE_PENDING_REQUEST_LIFETIME_HOURS = 24;

export function createOneTimeCode() {
  // `randomInt` is uniform over the range; `Math.random()` is neither uniform
  // enough nor unpredictable enough for a credential.
  return String(randomInt(0, 10 ** ONE_TIME_CODE_DIGITS))
    .padStart(ONE_TIME_CODE_DIGITS, "0");
}

export function hashOneTimeCode(code: string) {
  return createHash("sha256").update(normalizeSubmittedCode(code)).digest("hex");
}

/**
 * What a password manager or phone autofill actually hands over. "123 456" is
 * what the recipient sees in the email, so it is what gets copied; trimming the
 * ends alone would reject it. Mirrors `OneTimeCodeInput` on the client, which
 * removes the same whitespace before the value is ever submitted.
 */
export function normalizeSubmittedCode(code: string) {
  return code.replace(/\s+/g, "");
}

/**
 * Compares two digests without leaking, through timing, how much of one matched.
 */
export function oneTimeCodeMatches(submitted: string, storedHash: string | null) {
  if (!storedHash) return false;
  const expected = Buffer.from(storedHash, "utf8");
  const actual = Buffer.from(hashOneTimeCode(submitted), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
