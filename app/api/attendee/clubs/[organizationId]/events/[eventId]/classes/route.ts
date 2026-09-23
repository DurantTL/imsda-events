import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { clubRegistrationApiError } from "@/modules/club-registrations/api-errors";
import { setClassSelections } from "@/modules/honors/enrollment-repository";
import { withRequestContext } from "@/lib/request-context";

const selectionsSchema = z.object({
  selections: z.record(z.string().min(1).max(64), z.array(z.string().min(1).max(64)).max(6)),
}).strict().refine((input) => Object.keys(input.selections).length <= 60, "Too many people in one save.");

/** Saves class choices for the club's people. Seats are taken on the server; see enrollment-repository. */
async function putHandler(request: Request, context: { params: Promise<{ organizationId: string; eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, eventId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    const { selections } = selectionsSchema.parse(await request.json());
    const workspace = await setClassSelections(organizationId, eventId, access.accountId, selections);
    return Response.json({ workspace }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubRegistrationApiError(error, "Saving class choices");
  }
}

export const PUT = withRequestContext(putHandler);
