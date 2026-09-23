import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError, requireOwnAttendeeSession } from "@/modules/attendee-accounts/passkey-api";
import { beginPasskeyVerification } from "@/modules/attendee-accounts/passkeys";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, sessionId } = await requireOwnAttendeeSession();
    return Response.json({ options: await beginPasskeyVerification(account, sessionId, request.headers.get("origin")) });
  } catch (error) {
    return passkeyApiError(error, "Starting a passkey check");
  }
}

export const POST = withRequestContext(postHandler);
