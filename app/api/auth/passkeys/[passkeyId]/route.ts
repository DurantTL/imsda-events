import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { managementRateLimited, passkeyApiError, readChangeProof, requireOwnStaffSession } from "@/modules/access/passkey-api";
import { removePasskey, renamePasskey } from "@/modules/access/passkeys";
import { withRequestContext } from "@/lib/request-context";

const renameSchema = z.object({ name: z.string().max(60) }).strict();

async function patchHandler(request: Request, { params }: { params: Promise<{ passkeyId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account } = await requireOwnStaffSession();
    const limited = await managementRateLimited(request, account.id);
    if (limited) return limited;
    const { passkeyId } = await params;
    const { name } = renameSchema.parse(await request.json());
    return Response.json({ passkeys: await renamePasskey(account, passkeyId, name) });
  } catch (error) {
    return passkeyApiError(error, "Renaming a passkey");
  }
}

async function deleteHandler(request: Request, { params }: { params: Promise<{ passkeyId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, sessionId } = await requireOwnStaffSession();
    const limited = await managementRateLimited(request, account.id);
    if (limited) return limited;
    const { passkeyId } = await params;
    // Removing needs a fresh proof in the body, like adding (#429); renaming doesn't.
    const proof = await readChangeProof(request);
    return Response.json({ passkeys: await removePasskey(account, sessionId, request.headers.get("origin"), passkeyId, proof) });
  } catch (error) {
    return passkeyApiError(error, "Removing a passkey");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
