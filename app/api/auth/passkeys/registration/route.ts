import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError, requireOwnStaffSession } from "@/modules/access/passkey-api";
import { finishPasskeyRegistration } from "@/modules/access/passkeys";
import { passkeyRegistrationSchema } from "@/modules/passkeys/schemas";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, sessionId } = await requireOwnStaffSession();
    const input = passkeyRegistrationSchema.parse(await request.json());
    const passkeys = await finishPasskeyRegistration(account, sessionId, request.headers.get("origin"), {
      response: input.response as unknown as RegistrationResponseJSON,
      name: input.name,
    });
    return Response.json({ passkeys }, { status: 201 });
  } catch (error) {
    return passkeyApiError(error, "Adding a passkey");
  }
}

export const POST = withRequestContext(postHandler);
