import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireClubDriverReviewAccess } from "@/modules/driver-verification/access";
import { driverVerificationApiError } from "@/modules/driver-verification/api-errors";
import { recordDriverClearance } from "@/modules/driver-verification/repository";
import { driverClearanceSchema } from "@/modules/driver-verification/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; personId: string }> };

/**
 * A club director or deputy's decision on one of their own club's willing
 * drivers (#491). `recordDriverClearance` refuses a person outside this
 * club's current roster, and refuses self-nomination outright.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, personId } = await context.params;
    const access = await requireClubDriverReviewAccess(organizationId);
    const { clearedToTransport, note } = driverClearanceSchema.parse(await request.json());
    await recordDriverClearance(personId, { kind: "CLUB", organizationId }, { clearedToTransport, note }, access.actor);
    return Response.json({ ok: true });
  } catch (error) {
    return driverVerificationApiError(error, "Recording a driver clearance decision");
  }
}

export const POST = withRequestContext(postHandler);
