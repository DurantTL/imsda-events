import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { memberHonorApiError } from "@/modules/honors/member-honor-api-errors";
import { voidMemberHonorEntryAsStaff } from "@/modules/honors/member-honor-repository";
import { voidMemberHonorEntrySchema } from "@/modules/honors/member-honor-schemas";
import { requireSystemAdministrator } from "@/modules/organizations/access";

type RouteContext = { params: Promise<{ entryId: string }> };

/**
 * Staff void of one honor entry by id (#591). System administrators only (the
 * permission the staff club and roster screens use); no recording-club check,
 * so an entry from a deactivated club can still be voided. Same reason rules,
 * transaction and audit as the club's own void; a double void is a 409.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = await requireSystemAdministrator();
    const { entryId } = await context.params;
    const input = voidMemberHonorEntrySchema.parse(await request.json());
    await voidMemberHonorEntryAsStaff(entryId, input.reason, user.id);
    return Response.json({ voided: true });
  } catch (error) {
    return memberHonorApiError(error, "Voiding this honor entry");
  }
}

export const POST = withRequestContext(postHandler);
