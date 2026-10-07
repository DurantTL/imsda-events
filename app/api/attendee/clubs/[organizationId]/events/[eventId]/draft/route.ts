import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { clubRegistrationApiError } from "@/modules/club-registrations/api-errors";
import { saveClubRegistrationDraft } from "@/modules/club-registrations/repository";
import { clubGuestsSchema, rosterAgesSchema, rosterAgeSaveOffSchema } from "@/modules/club-registrations/domain";
import { honorSelectionsSchema } from "@/modules/honors/registration-picks";
import { withRequestContext } from "@/lib/request-context";

const draftSchema = z.object({
  selectedMemberIds: z.array(z.string().min(1).max(64)).max(50),
  guests: clubGuestsSchema.default([]),
  responses: z.record(z.string(), z.unknown()),
  attendeeResponses: z.record(z.string(), z.record(z.string(), z.unknown())),
  honorSelections: honorSelectionsSchema.default({}),
  rosterAges: rosterAgesSchema.default({}),
  rosterAgeSaveOff: rosterAgeSaveOffSchema.default([]),
  locationId: z.string().min(1).max(64).nullable().optional(),
  // Which team's draft this is, and the name typed so far (#809); both absent on an event without teams.
  draftKey: z.string().max(64).optional(),
  teamName: z.string().max(200).optional(),
  baseRevision: z.number().int().min(0),
  saveId: z.string().min(8).max(64),
}).strict();

type RouteContext = { params: Promise<{ organizationId: string; eventId: string }> };

async function putHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, eventId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "registerForEvents");
    const input = draftSchema.parse(await request.json());
    return Response.json(await saveClubRegistrationDraft(organizationId, eventId, actorAttribution(access.actor), input));
  } catch (error) {
    return clubRegistrationApiError(error, "Saving the draft");
  }
}

export const PUT = withRequestContext(putHandler);
