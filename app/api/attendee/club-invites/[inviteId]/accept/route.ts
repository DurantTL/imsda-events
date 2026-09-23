import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { clubImportApiError } from "@/modules/club-imports/api-errors";
import { acceptClubInvite } from "@/modules/club-imports/invites";
import { withRequestContext } from "@/lib/request-context";

/** The invited person accepts from their own account (#376). Their verified email must be the invite's. */
async function postHandler(request: Request, context: { params: Promise<{ inviteId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { account, via } = await getCurrentAttendee();
    if (!account || via !== "attendee") {
      return Response.json({ error: "SIGN_IN_REQUIRED", message: "Sign in with your own account to accept the invite." }, { status: 401 });
    }
    const { inviteId } = await context.params;
    const result = await acceptClubInvite(inviteId, { id: account.id, verifiedEmail: account.verifiedEmail });
    return Response.json({ ok: true, clubUrl: `/account/clubs/${encodeURIComponent(result.organizationId)}` });
  } catch (error) {
    return clubImportApiError(error, "Accepting a club invite");
  }
}

export const POST = withRequestContext(postHandler);
