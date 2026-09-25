import "server-only";

import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { currentStaffPasskeySession, PasskeyError } from "@/modules/access/passkeys";

const statusFor: Record<PasskeyError["code"], number> = {
  PASSKEYS_NOT_AVAILABLE: 409,
  CHALLENGE_EXPIRED: 400,
  PASSKEY_NOT_VERIFIED: 400,
  PASSKEY_NOT_FOUND: 404,
  LAST_SIGN_IN_METHOD: 409,
};

export class PasskeySessionError extends Error {}

/** Passkey management belongs to the signed-in staff member's own session. */
export async function requireOwnStaffSession() {
  const session = await currentStaffPasskeySession();
  if (!session) throw new PasskeySessionError();
  return session;
}

export function passkeyApiError(error: unknown, action: string) {
  if (error instanceof PasskeySessionError) {
    return Response.json(
      { error: "AUTHENTICATION_REQUIRED", message: "Sign in to manage your passkeys." },
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
