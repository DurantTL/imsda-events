import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError, requireOwnAttendeeSession } from "@/modules/attendee-accounts/passkey-api";
import { passkeyRegistrationSchema } from "@/modules/attendee-accounts/passkey-schemas";
import { finishPasskeyRegistration } from "@/modules/attendee-accounts/passkeys";
import { markRosterUnlocked } from "@/modules/club-rosters/access";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, sessionId } = await requireOwnAttendeeSession();
    const input = passkeyRegistrationSchema.parse(await request.json());
    const passkeys = await finishPasskeyRegistration(account, sessionId, request.headers.get("origin"), {
      response: input.response as unknown as RegistrationResponseJSON,
      name: input.name,
    });
    // The passkey required the person's fingerprint, face, or PIN: this sign-in has passed its second step.
    await markRosterUnlocked(sessionId);
    return Response.json({ passkeys }, { status: 201 });
  } catch (error) {
    return passkeyApiError(error, "Adding a passkey");
  }
}

export const POST = withRequestContext(postHandler);
