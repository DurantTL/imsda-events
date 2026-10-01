import { after } from "next/server";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { requireHealthViewerForClub } from "@/modules/health-records/access";
import { healthApiError, healthDisabledResponse, healthJson, readHealthJson } from "@/modules/health-records/api";
import { HEALTH_RECORD_LINK_MAX_DAYS } from "@/modules/health-records/domain";
import { createHealthRecordLink, listHealthRecordLinks } from "@/modules/health-records/repository";

type RouteContext = { params: Promise<{ organizationId: string; memberId: string }> };

const createLinkSchema = z.object({
  recipientEmail: z.email("Enter a valid email address.").max(160),
  expiresInDays: z.number().int().min(1).max(HEALTH_RECORD_LINK_MAX_DAYS).optional(),
}).strict();

async function getHandler(_request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  try {
    const { organizationId, memberId } = await context.params;
    const viewer = await requireHealthViewerForClub(organizationId);
    return healthJson({ links: await listHealthRecordLinks(viewer, organizationId, memberId) });
  } catch (error) {
    return healthApiError(error, "Listing health record links");
  }
}

/** Emails the parent a single-use private link. The link is never in the response. */
async function postHandler(request: Request, context: RouteContext) {
  const disabled = healthDisabledResponse();
  if (disabled) return disabled;
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, memberId } = await context.params;
    const viewer = await requireHealthViewerForClub(organizationId);
    const input = createLinkSchema.parse(await readHealthJson(request));
    const result = await createHealthRecordLink(viewer, { organizationId, rosterMemberId: memberId, ...input });
    after(async () => {
      try {
        await processAccountEmailQueue({ messageIds: [result.messageId], limit: 1 });
      } catch (error) {
        logError("A health record link email was queued but not delivered after the response.", error, { messageId: result.messageId });
      }
    });
    return healthJson({ ok: true, linkId: result.linkId, expiresAt: result.expiresAt.toISOString() }, { status: 201 });
  } catch (error) {
    return healthApiError(error, "Sending a health record link");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
