import { safeReturnTo } from "@/lib/return-to";

export const ATTENDEE_SIGN_IN_PATH = "/account/sign-in";
export const TWO_STEP_PATH = "/account/two-step";

/** Sign-in and recovery screens are never a place to return to. */
const NON_RETURNABLE_PATHS = [
  ATTENDEE_SIGN_IN_PATH,
  "/account/sign-up",
  "/account/forgot-password",
  TWO_STEP_PATH,
  "/profile/sign-in",
] as const;

/**
 * A destination that may be carried through attendee sign-in and the second
 * step (#568): a `safeReturnTo` path inside the signed-in account area or the
 * profile page, never one of the sign-in screens themselves. Anything else
 * (an off-site URL, an API route, another workspace) yields `fallback`.
 */
export function attendeeReturnDestination(value: string | null | undefined, fallback: string): string {
  const safe = safeReturnTo(value, "");
  if (!safe) return fallback;
  const pathname = safe.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  if ((NON_RETURNABLE_PATHS as readonly string[]).includes(pathname)) return fallback;
  const inAccount = pathname === "/account" || pathname.startsWith("/account/");
  const inProfile = pathname === "/profile" || pathname.startsWith("/profile/");
  return inAccount || inProfile ? safe : fallback;
}

function pathWithNext(base: string, target: string | null | undefined): string {
  const safe = attendeeReturnDestination(target, "");
  return safe ? `${base}?next=${encodeURIComponent(safe)}` : base;
}

/** `/account/sign-in`, carrying `target` as `?next=` only when it is a safe destination. */
export function attendeeSignInPathFor(target: string | null | undefined): string {
  return pathWithNext(ATTENDEE_SIGN_IN_PATH, target);
}

/** `/account/two-step`, carrying `target` as `?next=` only when it is a safe destination. */
export function twoStepPathFor(target: string | null | undefined): string {
  return pathWithNext(TWO_STEP_PATH, target);
}
