import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError, requireOwnAttendeeSession } from "@/modules/attendee-accounts/passkey-api";
import { removePasskey } from "@/modules/attendee-accounts/passkeys";
import { withRequestContext } from "@/lib/request-context";

async function deleteHandler(request: Request, { params }: { params: Promise<{ passkeyId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, sessionId } = await requireOwnAttendeeSession();
    const { passkeyId } = await params;
    return Response.json({ passkeys: await removePasskey(account, sessionId, passkeyId) });
  } catch (error) {
    return passkeyApiError(error, "Removing a passkey");
  }
}

export const DELETE = withRequestContext(deleteHandler);
