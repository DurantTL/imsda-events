import { withRequestContext } from "@/lib/request-context";
import { memberHonorEntrySchema } from "@/modules/honors/member-honor-schemas";
import { requireHonorsAccess, requireHonorsEditAccess } from "@/modules/honors/member-honor-access";
import { memberHonorApiError } from "@/modules/honors/member-honor-api-errors";
import { listMemberHonorHistory, recordMemberHonorEntries } from "@/modules/honors/member-honor-repository";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";

type RouteContext = { params: Promise<{ organizationId: string; memberId: string }> };

/** One member's full honor history (#486): the append-only record behind their current status. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId, memberId } = await context.params;
    await requireHonorsAccess(organizationId);
    return Response.json(await listMemberHonorHistory(organizationId, memberId));
  } catch (error) {
    return memberHonorApiError(error, "Loading this person's honor history");
  }
}

/** Single-member edit (#486): the same append-only entry the bulk action writes, for one person. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, memberId } = await context.params;
    const actor = await requireHonorsEditAccess(organizationId);
    const input = memberHonorEntrySchema.parse(await request.json());
    await recordMemberHonorEntries(organizationId, [memberId], input, actor);
    return Response.json(await listMemberHonorHistory(organizationId, memberId), { status: 201 });
  } catch (error) {
    return memberHonorApiError(error, "Recording this honor");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
