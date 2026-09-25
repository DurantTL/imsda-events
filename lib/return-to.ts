/**
 * Validates a `returnTo`/`from` navigation parameter so a back link can send
 * someone to wherever they actually came from without becoming an open
 * redirect (#428). Only a same-site relative path is ever accepted; anything
 * else — an absolute URL, a protocol-relative URL, a backslash trick, a
 * control character, an API route, or an encoded form of any of those —
 * falls back to the caller's default parent.
 */

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
/** Bounded: decoding more than a few times only matters for attacks. */
const MAX_DECODE_ROUNDS = 5;

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path[0] !== "/") return false;
  if (path.includes("//")) return false;
  if (path.includes("\\")) return false;
  if (CONTROL_CHAR_PATTERN.test(path)) return false;
  if (path === "/api" || path.startsWith("/api/") || path.startsWith("/api?")) return false;
  return true;
}

/**
 * Returns `value` when it is a safe, same-site relative path, otherwise
 * `fallback`. A safe path starts with a single "/", never contains "//" or a
 * backslash anywhere, has no scheme (so it can never start with something
 * like "javascript:" or "https://"), has no control characters, and is never
 * an API route — checked both on the raw value and on it decoded
 * (repeatedly, to catch double- or multiply-encoded tricks like "%2F%2F" or
 * "%5C"). If decoding is still changing the string when the round limit is
 * reached, the value is rejected rather than accepted on an unstable form.
 */
export function safeReturnTo(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (!isSafeRelativePath(value)) return fallback;

  let decoded = value;
  let stable = false;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return fallback;
    }
    if (!isSafeRelativePath(next)) return fallback;
    if (next === decoded) {
      stable = true;
      break;
    }
    decoded = next;
  }
  if (!stable) return fallback;

  return value;
}

/**
 * Stricter than `safeReturnTo`: accepts `value` only when it is both a safe
 * relative path AND exactly one of `allowed` — a page's known parents.
 * Prefer this over `safeReturnTo` alone whenever a page's set of legitimate
 * "came from" destinations is small and known ahead of time (#428 review):
 * it can't be steered to an arbitrary same-site path, only to one of the
 * places that actually link here.
 */
export function allowedReturnTo(value: string | null | undefined, allowed: readonly string[], fallback: string): string {
  const validated = safeReturnTo(value, fallback);
  return allowed.includes(validated) ? validated : fallback;
}
