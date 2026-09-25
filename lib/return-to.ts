/**
 * Validates a `returnTo`/`from` navigation parameter so a back link can send
 * someone to wherever they actually came from without becoming an open
 * redirect (#428). Only a same-site relative path is ever accepted; anything
 * else — an absolute URL, a protocol-relative URL, a backslash trick, a
 * control character, or an encoded form of any of those — falls back to the
 * caller's default parent.
 */

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
/** Bounded: decoding more than a couple of times only matters for attacks. */
const MAX_DECODE_ROUNDS = 3;

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path[0] !== "/") return false;
  if (path.includes("//")) return false;
  if (path.includes("\\")) return false;
  if (CONTROL_CHAR_PATTERN.test(path)) return false;
  return true;
}

/**
 * Returns `value` when it is a safe, same-site relative path, otherwise
 * `fallback`. A safe path starts with a single "/", never contains "//" or a
 * backslash anywhere, has no scheme (so it can never start with something
 * like "javascript:" or "https://"), and has no control characters — checked
 * both on the raw value and on it decoded (repeatedly, to catch
 * double-encoded tricks like "%2F%2F" or "%5C").
 */
export function safeReturnTo(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (!isSafeRelativePath(value)) return fallback;

  let decoded = value;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return fallback;
    }
    if (!isSafeRelativePath(next)) return fallback;
    if (next === decoded) break;
    decoded = next;
  }

  return value;
}
