import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { listRegistrationMoves } from "@/modules/club-transfers/repository";
import { withRequestContext } from "@/lib/request-context";

/** The registration-move approval list (#489): pending by default, or `?status=decided`. */
async function getHandler(request: Request) {
  try {
    await requireStaffTransferAccess();
    const status = new URL(request.url).searchParams.get("status") === "decided" ? "DECIDED" : "PENDING";
    return Response.json({ moves: await listRegistrationMoves(status) });
  } catch (error) {
    return memberTransferApiError(error, "Loading registration moves");
  }
}

export const GET = withRequestContext(getHandler);
