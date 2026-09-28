import { requireClubTransferAccess } from "@/modules/club-transfers/access";
import { memberTransferApiError } from "@/modules/club-transfers/api-errors";
import { searchTransferCandidates } from "@/modules/club-transfers/repository";
import { transferSearchQuerySchema } from "@/modules/club-transfers/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * Search other clubs' active rosters by name (#489), for a receiving
 * director enrolling someone who's transferring in. Never returns a birth
 * date or age — a cross-club search isn't the roster's own "see birth
 * dates" gate (ADR 0005 Addendum A), so it never carries one at all.
 */
async function getHandler(request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    await requireClubTransferAccess(organizationId);
    const { q } = transferSearchQuerySchema.parse({ q: new URL(request.url).searchParams.get("q") ?? "" });
    const candidates = await searchTransferCandidates(q, organizationId);
    return Response.json({ candidates });
  } catch (error) {
    return memberTransferApiError(error, "Searching for a transferring member");
  }
}

export const GET = withRequestContext(getHandler);
