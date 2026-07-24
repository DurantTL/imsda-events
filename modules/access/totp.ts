import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 time-based one-time passwords, and the RFC 4648 base32 the
 * authenticator apps expect a secret in.
 *
 * Pure and dependency-free: no database, no clock of its own — the caller
 * passes the time. That makes drift, replay, and step arithmetic testable
 * without mocking a system clock.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/**
 * How many steps either side of now are accepted. One step — thirty seconds —
 * covers an authenticator whose clock has drifted slightly and the seconds a
 * person spends typing. More would widen the window a stolen code stays usable
 * in for no real gain.
 */
export const TOTP_DRIFT_STEPS = 1;
/** 160 bits, the size RFC 4226 recommends for HMAC-SHA1. */
const SECRET_BYTES = 20;

export function encodeBase32(bytes: Buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(encoded: string) {
  const normalized = encoded.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error("The secret is not valid base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return encodeBase32(randomBytes(SECRET_BYTES));
}

/** The step a moment falls in. Exported because replay protection stores it. */
export function totpStep(at: Date, stepSeconds = TOTP_STEP_SECONDS) {
  return Math.floor(at.getTime() / 1000 / stepSeconds);
}

export function totpCodeForStep(secretBase32: string, step: number, digits = TOTP_DIGITS) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", decodeBase32(secretBase32)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export function totpCode(secretBase32: string, at: Date) {
  return totpCodeForStep(secretBase32, totpStep(at));
}

export type TotpVerification =
  | { valid: true; step: number }
  | { valid: false; reason: "MALFORMED" | "MISMATCH" | "ALREADY_USED" };

/**
 * Verifies a presented code within the drift window.
 *
 * `lastUsedStep` is what stops a code being replayed inside its own thirty
 * seconds: an accepted step, and everything before it, is spent. Without that,
 * a code read over someone's shoulder — or captured from a phishing page — is
 * usable until the step rolls over.
 */
export function verifyTotp(
  secretBase32: string,
  presented: string,
  options: { at: Date; lastUsedStep?: number | null; driftSteps?: number },
): TotpVerification {
  const normalized = presented.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) {
    return { valid: false, reason: "MALFORMED" };
  }

  const drift = options.driftSteps ?? TOTP_DRIFT_STEPS;
  const current = totpStep(options.at);
  const presentedBytes = Buffer.from(normalized, "utf8");
  let matched: number | null = null;
  for (let offset = -drift; offset <= drift; offset += 1) {
    const step = current + offset;
    const expected = Buffer.from(totpCodeForStep(secretBase32, step), "utf8");
    // Compared for every candidate step rather than breaking early, so the
    // work does not depend on which step matched.
    if (expected.length === presentedBytes.length && timingSafeEqual(expected, presentedBytes)) {
      matched = step;
    }
  }
  if (matched === null) return { valid: false, reason: "MISMATCH" };
  if (options.lastUsedStep != null && matched <= options.lastUsedStep) {
    return { valid: false, reason: "ALREADY_USED" };
  }
  return { valid: true, step: matched };
}

/**
 * The URI an authenticator app scans. The label and issuer identify the account
 * in the app's list; neither is a secret.
 */
export function otpauthUri(input: {
  secretBase32: string;
  accountName: string;
  issuer: string;
}) {
  const label = `${input.issuer}:${input.accountName}`;
  const parameters = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${parameters.toString()}`;
}
