import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { withRequestContext } from "@/lib/request-context";
import { newClubApplicationApiError } from "@/modules/club-applications/api-errors";
import { cancelNewClubInvite, listNewClubInvites } from "@/modules/club-applications/repository";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/** Withdraws a private "apply for a new club" link that hasn't been used (#817). */
async function deleteHandler(request: Request, context: { params: Promise<{ inviteId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { inviteId } = await context.params;
    await cancelNewClubInvite(actor, inviteId);
    return Response.json({ ok: true, invites: await listNewClubInvites("SYSTEM_ADMIN") });
  } catch (error) {
    return newClubApplicationApiError(error, "Withdrawing a new club application link");
  }
}

export const DELETE = withRequestContext(deleteHandler);
