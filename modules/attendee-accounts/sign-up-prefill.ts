/**
 * A convenience only: query text may populate the sign-up form, but it never
 * proves identity. The account flow still sends and verifies its own code.
 */
export function attendeeSignUpEmailPrefill(
  value: string | string[] | undefined,
) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  if (
    candidate.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)
  ) {
    return "";
  }
  return candidate;
}
