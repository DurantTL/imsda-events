import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import {
  AttendeeMfaError,
  beginAttendeeMfaEnrollment,
  confirmAttendeeMfaEnrollment,
  disableAttendeeMfa,
  getAttendeeMfaStatus,
  regenerateAttendeeRecoveryCodes,
} from "@/modules/attendee-accounts/mfa-service";

const code = z.string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().min(1).max(32));

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }),
  z.object({ action: z.literal("confirm"), code }),
  z.object({ action: z.literal("regenerate-recovery-codes") }),
  z.object({ action: z.literal("disable"), code }),
]);

function failure(error: unknown) {
  if (error instanceof AttendeeMfaError) {
    return Response.json({ error: error.code, message: error.message }, { status: 400 });
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_REQUEST", message: "That request could not be completed." },
      { status: 400 },
    );
  }
  logError("Attendee MFA request failed", error);
  return Response.json(
    { error: "MFA_REQUEST_FAILED", message: "Two-factor settings are temporarily unavailable." },
    { status: 500 },
  );
}

async function accountId() {
  return (await getCurrentAttendee()).account?.id ?? null;
}

async function getHandler() {
  const id = await accountId();
  return id
    ? Response.json(await getAttendeeMfaStatus(id))
    : Response.json({ error: "SIGN_IN_REQUIRED", message: "Sign in first." }, { status: 401 });
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const id = await accountId();
  if (!id) {
    return Response.json({ error: "SIGN_IN_REQUIRED", message: "Sign in first." }, { status: 401 });
  }
  try {
    const input = actionSchema.parse(await request.json());
    if (input.action === "begin") {
      return Response.json(await beginAttendeeMfaEnrollment(id));
    }
    if (input.action === "confirm") {
      const confirmed = await confirmAttendeeMfaEnrollment(id, input.code);
      return Response.json({ ...confirmed, status: await getAttendeeMfaStatus(id) });
    }
    if (input.action === "regenerate-recovery-codes") {
      return Response.json(await regenerateAttendeeRecoveryCodes(id));
    }
    await disableAttendeeMfa(id, input.code);
    return Response.json({ ok: true, status: await getAttendeeMfaStatus(id) });
  } catch (error) {
    return failure(error);
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
