import { withRequestContext } from "@/lib/request-context";
import { voidMemberHonorEntrySchema } from "@/modules/honors/member-honor-schemas";
import { requireHonorsVoidAccess } from "@/modules/honors/member-honor-access";
import { memberHonorApiError } from "@/modules/honors/member-honor-api-errors";
import { listMemberHonorHistory, voidMemberHonorEntry } from "@/modules/honors/member-honor-repository";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";

type RouteContext = { params: Promise<{ organizationId: string; memberId: string; entryId: string }> };

/**
 * Voids one honor entry (#591). The server re-checks the role and that the
 * entry is this club's; the entry is kept, with who, when and why. A second
 * void of the same entry is a 409. Returns the refreshed history.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, memberId, entryId } = await context.params;
    const actor = await requireHonorsVoidAccess(organizationId);
    const input = voidMemberHonorEntrySchema.parse(await request.json());
    await voidMemberHonorEntry(organizationId, memberId, entryId, input.reason, actor);
    return Response.json(await listMemberHonorHistory(organizationId, memberId));
  } catch (error) {
    return memberHonorApiError(error, "Voiding this honor entry");
  }
}

export const POST = withRequestContext(postHandler);
