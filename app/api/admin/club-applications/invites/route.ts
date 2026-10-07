import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { withRequestContext } from "@/lib/request-context";
import { newClubApplicationApiError } from "@/modules/club-applications/api-errors";
import { newClubInviteInputSchema } from "@/modules/club-applications/domain";
import { createNewClubInvite, listNewClubInvites } from "@/modules/club-applications/repository";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/**
 * A system administrator sends a private "apply for a new club" link to a
 * prospective director (#817). The link is emailed (never shown here) and
 * works once.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const input = newClubInviteInputSchema.parse(await request.json());
    await createNewClubInvite(actor, input);
    return Response.json({ ok: true, invites: await listNewClubInvites("SYSTEM_ADMIN") }, { status: 201 });
  } catch (error) {
    return newClubApplicationApiError(error, "Sending a new club application link");
  }
}

export const POST = withRequestContext(postHandler);
