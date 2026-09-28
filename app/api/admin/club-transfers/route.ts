import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { listStaffTransferQueue } from "@/modules/club-transfers/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * The conference staff queue (#489): a pending transfer the sending club
 * hasn't acknowledged within 14 days.
 */
async function getHandler() {
  try {
    await requireStaffTransferAccess();
    const transfers = await listStaffTransferQueue();
    return Response.json({ transfers });
  } catch (error) {
    return memberTransferApiError(error, "Loading the club transfer queue");
  }
}

export const GET = withRequestContext(getHandler);
