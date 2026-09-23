import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { clubRegistrationApiError } from "@/modules/club-registrations/api-errors";
import { saveClubRegistrationDraft } from "@/modules/club-registrations/repository";
import { withRequestContext } from "@/lib/request-context";

const draftSchema = z.object({
  selectedMemberIds: z.array(z.string().min(1).max(64)).max(50),
  responses: z.record(z.string(), z.unknown()),
  attendeeResponses: z.record(z.string(), z.record(z.string(), z.unknown())),
}).strict();

type RouteContext = { params: Promise<{ organizationId: string; eventId: string }> };

async function putHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, eventId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    const input = draftSchema.parse(await request.json());
    return Response.json(await saveClubRegistrationDraft(organizationId, eventId, access.accountId, input));
  } catch (error) {
    return clubRegistrationApiError(error, "Saving the draft");
  }
}

export const PUT = withRequestContext(putHandler);
