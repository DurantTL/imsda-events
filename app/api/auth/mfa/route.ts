import { z } from "zod";
import { logError } from "@/lib/logger";
import {
  AccessDeniedError,
  requireAuthenticatedUser,
} from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import {
  MfaError,
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  getMfaStatus,
  regenerateRecoveryCodes,
} from "@/modules/access/mfa-service";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";

/**
 * Managing the second factor from inside a signed-in session: the enrolment a
 * person does before their role requires it, and the recovery codes they
 * regenerate after using one.
 *
 * Enrolling *because* a role requires it happens during sign-in instead — see
 * `mfa/challenge` — because that account has no session yet.
 */

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }),
  z.object({ action: z.literal("confirm"), code: z.string().trim().min(1).max(32) }),
  z.object({ action: z.literal("regenerate-recovery-codes") }),
  z.object({ action: z.literal("disable"), code: z.string().trim().min(1).max(32) }),
]);

function apiError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof MfaError) {
    return Response.json({ error: error.code, message: error.message }, { status: 400 });
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_REQUEST", message: "That request could not be completed." },
      { status: 400 },
    );
  }
  logError("MFA request failed", error);
  return Response.json(
    { error: "MFA_REQUEST_FAILED", message: "Two-factor settings are temporarily unavailable." },
    { status: 500 },
  );
}

export async function GET() {
  try {
    const user = requireAuthenticatedUser(await getCurrentSession());
    return Response.json(await getMfaStatus(user.id));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  try {
    const user = requireAuthenticatedUser(await getCurrentSession());
    const input = actionSchema.parse(await request.json());

    if (input.action === "begin") {
      return Response.json(await beginMfaEnrollment(user.id));
    }
    if (input.action === "confirm") {
      const confirmed = await confirmMfaEnrollment(user.id, input.code);
      return Response.json({
        ...confirmed,
        status: await getMfaStatus(user.id),
      });
    }
    if (input.action === "regenerate-recovery-codes") {
      return Response.json(await regenerateRecoveryCodes(user.id));
    }

    await disableMfa(user.id, input.code);
    return Response.json({ ok: true, status: await getMfaStatus(user.id) });
  } catch (error) {
    return apiError(error);
  }
}
