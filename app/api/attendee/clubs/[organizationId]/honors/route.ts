import { withRequestContext } from "@/lib/request-context";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { bulkMemberHonorEntrySchema } from "@/modules/honors/member-honor-schemas";
import { requireHonorsAccess, requireHonorsEditAccess } from "@/modules/honors/member-honor-access";
import { memberHonorApiError } from "@/modules/honors/member-honor-api-errors";
import { listActiveHonorOptions, listClubHonorsPage, recordMemberHonorEntries } from "@/modules/honors/member-honor-repository";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";

type RouteContext = { params: Promise<{ organizationId: string }> };

async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireHonorsAccess(organizationId);
    const clubYear = clubYearFor(new Date());
    const [rows, honors] = await Promise.all([
      listClubHonorsPage(organizationId, clubYear),
      listActiveHonorOptions(),
    ]);
    return Response.json({ clubYear, rows, honors, readOnly: access.mode === "READ" });
  } catch (error) {
    return memberHonorApiError(error, "Loading club honors");
  }
}

/** Bulk entry (#486): mark the same honor in progress or completed for many members at once. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const actor = await requireHonorsEditAccess(organizationId);
    const input = bulkMemberHonorEntrySchema.parse(await request.json());
    await recordMemberHonorEntries(organizationId, input.memberIds, input, actor);
    const clubYear = clubYearFor(new Date());
    return Response.json({ clubYear, rows: await listClubHonorsPage(organizationId, clubYear) }, { status: 201 });
  } catch (error) {
    return memberHonorApiError(error, "Recording honors");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
