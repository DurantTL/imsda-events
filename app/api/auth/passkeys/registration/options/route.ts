import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError, requireOwnStaffSession } from "@/modules/access/passkey-api";
import { beginPasskeyRegistration } from "@/modules/access/passkeys";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, sessionId } = await requireOwnStaffSession();
    return Response.json({ options: await beginPasskeyRegistration(account, sessionId, request.headers.get("origin")) });
  } catch (error) {
    return passkeyApiError(error, "Starting to add a passkey");
  }
}

export const POST = withRequestContext(postHandler);
