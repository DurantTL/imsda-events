import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { managementRateLimited, passkeyApiError, readChangeProof, requireOwnStaffSession } from "@/modules/access/passkey-api";
import { beginPasskeyRegistration } from "@/modules/access/passkeys";
import { withRequestContext } from "@/lib/request-context";

/**
 * Starts adding a passkey (#429). The body carries a fresh proof — an
 * authenticator or recovery code, an existing passkey's answer, or the
 * current password — checked before any registration prompt is issued.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, sessionId } = await requireOwnStaffSession();
    const limited = await managementRateLimited(request, account.id);
    if (limited) return limited;
    const proof = await readChangeProof(request);
    return Response.json({ options: await beginPasskeyRegistration(account, sessionId, request.headers.get("origin"), proof) });
  } catch (error) {
    return passkeyApiError(error, "Starting to add a passkey");
  }
}

export const POST = withRequestContext(postHandler);
