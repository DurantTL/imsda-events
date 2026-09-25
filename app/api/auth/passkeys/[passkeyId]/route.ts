import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { passkeyApiError, requireOwnStaffSession } from "@/modules/access/passkey-api";
import { removePasskey, renamePasskey } from "@/modules/access/passkeys";
import { withRequestContext } from "@/lib/request-context";

const renameSchema = z.object({ name: z.string().max(60) }).strict();

async function patchHandler(request: Request, { params }: { params: Promise<{ passkeyId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account } = await requireOwnStaffSession();
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
    const { account } = await requireOwnStaffSession();
    const { passkeyId } = await params;
    return Response.json({ passkeys: await removePasskey(account, passkeyId) });
  } catch (error) {
    return passkeyApiError(error, "Removing a passkey");
  }
}

export const PATCH = withRequestContext(patchHandler);
export const DELETE = withRequestContext(deleteHandler);
