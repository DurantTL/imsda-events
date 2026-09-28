import { requireStaffTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { listStaffTransferQueue } from "@/modules/club-transfers/repository";
import { staffQueueQuerySchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

/**
 * The conference staff transfer queue (#489): every open transfer by
 * default, or only overdue (14+ days unanswered), declined, unmatched, or
 * pending ones with `?filter=`.
 */
async function getHandler(request: Request) {
  try {
    await requireStaffTransferAccess();
    const { filter } = staffQueueQuerySchema.parse({ filter: new URL(request.url).searchParams.get("filter") ?? undefined });
    const transfers = await listStaffTransferQueue(filter);
    return Response.json({ filter, transfers });
  } catch (error) {
    return memberTransferApiError(error, "Loading the club transfer queue");
  }
}

export const GET = withRequestContext(getHandler);
