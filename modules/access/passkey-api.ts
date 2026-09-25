import "server-only";

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z, ZodError } from "zod";
import { logError } from "@/lib/logger";
import { currentStaffPasskeySession, PasskeyError, type ChangeProof } from "@/modules/access/passkeys";
import { passkeyVerificationSchema } from "@/modules/passkeys/schemas";
import { applyRateLimitHeaders, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkStaffPasskeyManagementRateLimit } from "@/modules/rate-limit/service";

const statusFor: Record<PasskeyError["code"], number> = {
  PASSKEYS_NOT_AVAILABLE: 409,
  CHALLENGE_EXPIRED: 400,
  PASSKEY_NOT_VERIFIED: 400,
  PASSKEY_NOT_FOUND: 404,
  NO_PASSKEYS: 409,
  RECENT_VERIFICATION_REQUIRED: 403,
};

export class PasskeySessionError extends Error {}

/** Passkey management belongs to the signed-in staff member's own session. */
export async function requireOwnStaffSession() {
  const session = await currentStaffPasskeySession();
  if (!session) throw new PasskeySessionError();
  return session;
}

/**
 * The fresh proof sent with an add or remove (#429): one authenticator or
 * recovery code, one existing-passkey answer, or the current password. More
 * than one at once is refused rather than guessed at.
 */
const changeProofSchema = z.object({
  code: z.string().trim().min(1).max(32).optional(),
  password: z.string().min(1).max(128).optional(),
  passkey: passkeyVerificationSchema.shape.response.optional(),
}).strict().refine(
  (proof) => [proof.code, proof.password, proof.passkey].filter((value) => value !== undefined).length <= 1,
  { message: "Send one proof at a time." },
);

export const changeRequestSchema = z.object({ proof: changeProofSchema.optional() }).strict();

/** Reads the optional `{ proof }` body. An empty body means no proof, which the service refuses. */
export async function readChangeProof(request: Request): Promise<ChangeProof | undefined> {
  const text = await request.text();
  const { proof } = changeRequestSchema.parse(text.trim() ? JSON.parse(text) : {});
  if (!proof) return undefined;
  return {
    code: proof.code,
    password: proof.password,
    passkey: proof.passkey as unknown as AuthenticationResponseJSON | undefined,
  };
}

/** A cheap per-account limit on passkey management; returns a 429 response when spent. */
export async function managementRateLimited(request: Request, userId: string): Promise<Response | null> {
  const rateLimit: RateLimitOutcome = await checkStaffPasskeyManagementRateLimit(request, userId);
  if (rateLimit.allowed) return null;
  return applyRateLimitHeaders(
    Response.json({ error: "RATE_LIMITED", message: "Too many passkey changes. Try again later." }, { status: 429 }),
    rateLimit,
  );
}

export function passkeyApiError(error: unknown, action: string) {
  if (error instanceof PasskeySessionError) {
    return Response.json(
      { error: "AUTHENTICATION_REQUIRED", message: "Sign in to manage your passkeys." },
      { status: 401 },
    );
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return Response.json({ error: "INVALID_PASSKEY_REQUEST", message: "That passkey response wasn't readable." }, { status: 400 });
  }
  if (error instanceof PasskeyError) {
    return Response.json({ error: error.code, message: error.message }, { status: statusFor[error.code] });
  }
  // Never log the request body: it carries the credential response.
  logError(`${action} failed`, error);
  return Response.json({ error: "PASSKEY_REQUEST_FAILED", message: `${action} could not be completed.` }, { status: 500 });
}
