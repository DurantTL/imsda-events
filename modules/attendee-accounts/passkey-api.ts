import "server-only";

import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { PasskeyError } from "@/modules/attendee-accounts/passkeys";

const statusFor: Record<PasskeyError["code"], number> = {
  PASSKEYS_NOT_AVAILABLE: 409,
  RECENT_VERIFICATION_REQUIRED: 403,
  NO_PASSKEYS: 404,
  CHALLENGE_EXPIRED: 400,
  PASSKEY_NOT_VERIFIED: 400,
  PASSKEY_NOT_FOUND: 404,
  LAST_SECOND_STEP: 409,
};

export class PasskeySessionError extends Error {}

/** Passkeys belong to a person's own attendee sign-in, never a staff session viewing as them. */
export async function requireOwnAttendeeSession() {
  const { account, via, sessionId } = await getCurrentAttendee();
  if (!account || via !== "attendee" || !sessionId) throw new PasskeySessionError();
  return { account, sessionId };
}

export function passkeyApiError(error: unknown, action: string) {
  if (error instanceof PasskeySessionError) {
    return Response.json(
      { error: "OWN_SESSION_REQUIRED", message: "Sign in with your own attendee account to manage passkeys." },
      { status: 401 },
    );
  }
  if (error instanceof ZodError) {
    return Response.json({ error: "INVALID_PASSKEY_REQUEST", message: "That passkey response wasn't readable." }, { status: 400 });
  }
  if (error instanceof PasskeyError) {
    return Response.json({ error: error.code, message: error.message }, { status: statusFor[error.code] });
  }
  // Never log the request body: it carries the credential response.
  logError(`${action} failed`, error);
  return Response.json({ error: "PASSKEY_REQUEST_FAILED", message: `${action} could not be completed.` }, { status: 500 });
}
