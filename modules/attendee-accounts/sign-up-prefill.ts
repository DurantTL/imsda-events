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

const ATTENDEE_AUTH_RETURN_KEY = "imsda_attendee_auth_return";
const ATTENDEE_AUTH_RETURN_LIFETIME_MS = 20 * 60 * 1000;

export function attendeeAuthReturnPath(value: string | null | undefined) {
  if (!value || !/^\/manage\/[A-Za-z0-9_-]+$/.test(value)) return null;
  return value;
}

export function rememberAttendeeAuthReturnPath(
  value: string | null | undefined,
) {
  const path = attendeeAuthReturnPath(value);
  if (!path) return null;
  window.sessionStorage.setItem(ATTENDEE_AUTH_RETURN_KEY, JSON.stringify({
    path,
    expiresAt: Date.now() + ATTENDEE_AUTH_RETURN_LIFETIME_MS,
  }));
  return path;
}

export function attendeeAuthReturnPathFromHash(hash: string) {
  const parameters = new URLSearchParams(hash.replace(/^#/, ""));
  return rememberAttendeeAuthReturnPath(parameters.get("returnTo"));
}

export function removeAttendeeAuthFragment() {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

export function takeAttendeeAuthReturnPath() {
  const raw = window.sessionStorage.getItem(ATTENDEE_AUTH_RETURN_KEY);
  window.sessionStorage.removeItem(ATTENDEE_AUTH_RETURN_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as { path?: unknown; expiresAt?: unknown };
    if (typeof stored.expiresAt !== "number" || stored.expiresAt < Date.now()) {
      return null;
    }
    return typeof stored.path === "string"
      ? attendeeAuthReturnPath(stored.path)
      : null;
  } catch {
    return null;
  }
}
