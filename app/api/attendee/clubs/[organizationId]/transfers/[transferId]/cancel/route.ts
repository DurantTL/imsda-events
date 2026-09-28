import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { cancelTransferByClub } from "@/modules/club-transfers/repository";
import { clubNoteSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; transferId: string }> };

/** Either club cancels an open transfer (#489): the requesting club its own request, the sending club one still waiting on it. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, transferId } = await context.params;
    const access = await requireClubTransferAccess(organizationId);
    const { note } = clubNoteSchema.parse(await request.json().catch(() => ({})));
    return Response.json(await cancelTransferByClub(organizationId, transferId, note, access.actor));
  } catch (error) {
    return memberTransferApiError(error, "Cancelling a member transfer");
  }
}

export const POST = withRequestContext(postHandler);
