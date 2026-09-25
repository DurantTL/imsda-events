import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { managementRateLimited, passkeyApiError, requireOwnStaffSession } from "@/modules/access/passkey-api";
import { beginPasskeyVerification } from "@/modules/access/passkeys";
import { withRequestContext } from "@/lib/request-context";

/**
 * A prompt for one of the signed-in staff member's own passkeys (#429), used
 * as the "use an existing passkey" proof when adding or removing one. The
 * answer is sent with that add or remove request, not here.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, sessionId } = await requireOwnStaffSession();
    const limited = await managementRateLimited(request, account.id);
    if (limited) return limited;
    const options = await beginPasskeyVerification(account, sessionId, request.headers.get("origin"));
    return Response.json({ options }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return passkeyApiError(error, "Starting to confirm with a passkey");
  }
}

export const POST = withRequestContext(postHandler);
