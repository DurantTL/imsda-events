import { after } from "next/server";
import { withRequestContext } from "@/lib/request-context";
import { logError } from "@/lib/logger";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubLeaderViewer } from "@/modules/club-forms/access";
import { clubFormApiError, readClubFormJson } from "@/modules/club-forms/api-errors";
import { createClubFormLink } from "@/modules/club-forms/links";
import { createLinkSchema } from "@/modules/club-forms/schemas";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";
import { checkClubFormLinkCreateRateLimit } from "@/modules/rate-limit/service";

type RouteContext = { params: Promise<{ organizationId: string }> };

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * A director or deputy sends a single-use private link to one address they
 * type (#610). Rate limited per director, club, client and recipient. The
 * email is queued in the link's own transaction and delivered after it
 * commits; a delivery problem leaves it in the outbox for the sweep to retry.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const viewer = await requireClubLeaderViewer(organizationId);
    const input = createLinkSchema.parse(await readClubFormJson(request));
    const actorKey = viewer.actor.kind === "ATTENDEE" ? viewer.actor.accountId : viewer.actor.userId;
    const rateLimit = await checkClubFormLinkCreateRateLimit(request, actorKey, organizationId, input.recipientEmail);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(
        Response.json({ error: "RATE_LIMITED", message: "Too many links sent. Try again later." }, { status: 429 }),
        rateLimit,
      );
    }
    const { linkId, messageId, expiresAt } = await createClubFormLink(viewer, { ...input, organizationId });
    after(async () => {
      try {
        await processAccountEmailQueue({ messageIds: [messageId], limit: 1 });
      } catch (error) {
        logError("A club form link was queued but not delivered after the response.", error, { messageId });
      }
    });
    return Response.json({ link: { id: linkId, expiresAt: expiresAt.toISOString() } }, { status: 201, headers: privateHeaders });
  } catch (error) {
    return clubFormApiError(error, "Sending a club form link");
  }
}

export const POST = withRequestContext(postHandler);
