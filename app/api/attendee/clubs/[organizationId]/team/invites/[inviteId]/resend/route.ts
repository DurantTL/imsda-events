import { after } from "next/server";
import { logError } from "@/lib/logger";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { listPendingClubTeamInvites, resendClubTeamInvite } from "@/modules/club-imports/invites";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; inviteId: string }> };

/** A director or deputy resends a pending club team invite (#425): fresh expiry, rate-limited. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, inviteId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "manageTeam");
    const { messageId } = await resendClubTeamInvite(organizationId, inviteId, access.accountId);
    after(async () => {
      try {
        await processAccountEmailQueue({ messageIds: [messageId], limit: 1 });
      } catch (error) {
        logError("A resent club invite was queued but not delivered after the response.", error, { messageId });
      }
    });
    return Response.json({ invites: await listPendingClubTeamInvites(organizationId) });
  } catch (error) {
    return rosterApiError(error, "Resending a club team invite");
  }
}

export const POST = withRequestContext(postHandler);
