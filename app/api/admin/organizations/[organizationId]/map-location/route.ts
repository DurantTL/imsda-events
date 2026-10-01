import { z } from "zod";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { acceptGeocodeResult, skipGeocodeResult } from "@/modules/organizations/church-geocoding";

const bodySchema = z.object({ decision: z.enum(["accept", "skip"]) }).strict();

/**
 * Staff decide on one "Find map locations" result (#724): accept the match
 * (the church's location becomes GEOCODED) or skip it. Adjusting a point by
 * hand uses the church's location page instead. System administrators only.
 */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const { decision } = bodySchema.parse(await request.json());
    if (decision === "accept") await acceptGeocodeResult(organizationId, actor.id);
    else await skipGeocodeResult(organizationId, actor.id);
    return Response.json({ organizationId, decision }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return organizationApiError(error, "Reviewing a church map location");
  }
}

export const POST = withRequestContext(postHandler);
