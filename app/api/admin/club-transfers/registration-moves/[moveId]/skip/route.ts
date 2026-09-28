import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { skipRegistrationMove } from "@/modules/club-transfers/repository";
import { skipRegistrationMoveSchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ moveId: string }> };

/** Conference staff skip one registration move (#489): the registration stays with the old club. Audited. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { moveId } = await context.params;
    const actor = await requireStaffTransferAccess();
    const { note } = skipRegistrationMoveSchema.parse(await request.json().catch(() => ({})));
    return Response.json(await skipRegistrationMove(moveId, note, actor));
  } catch (error) {
    return memberTransferApiError(error, "Skipping a registration move");
  }
}

export const POST = withRequestContext(postHandler);
