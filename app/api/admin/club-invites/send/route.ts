import { after } from "next/server";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubImportApiError } from "@/modules/club-imports/api-errors";
import { listClubInvites, sendClubInvites } from "@/modules/club-imports/invites";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

const sendSchema = z.object({
  organizationId: z.string().trim().max(40).optional(),
  inviteIds: z.array(z.string().trim().max(40)).min(1).max(500).optional(),
}).strict();

/**
 * An administrator presses Send (#376): the only way a club invite is
 * emailed. Queued in the outbox, then delivered after the response; the
 * scheduled sweep is the durable fallback.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const selection = sendSchema.parse(await request.json());
    const { sent, messageIds } = await sendClubInvites(selection, actor.id);
    after(async () => {
      try {
        await processAccountEmailQueue({ messageIds, limit: messageIds.length });
      } catch (error) {
        logError("Club invites were queued but not delivered after the response.", error, { count: messageIds.length });
      }
    });
    return Response.json({ sent, invites: await listClubInvites() });
  } catch (error) {
    return clubImportApiError(error, "Sending club invites");
  }
}

export const POST = withRequestContext(postHandler);
