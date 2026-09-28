import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { declineTransfer } from "@/modules/club-transfers/repository";
import { clubNoteSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; transferId: string }> };

/** The sending club declines a transfer request (#489); it goes to conference staff. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, transferId } = await context.params;
    const access = await requireClubTransferAccess(organizationId);
    const { note } = clubNoteSchema.parse(await request.json().catch(() => ({})));
    return Response.json(await declineTransfer(organizationId, transferId, note, access.actor));
  } catch (error) {
    return memberTransferApiError(error, "Declining a member transfer");
  }
}

export const POST = withRequestContext(postHandler);
