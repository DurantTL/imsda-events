import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireGlobalDriverReviewAccess } from "@/modules/driver-verification/access";
import { driverVerificationApiError } from "@/modules/driver-verification/api-errors";
import { recordDriverClearance } from "@/modules/driver-verification/repository";
import { driverClearanceSchema } from "@/modules/driver-verification/schemas";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ personId: string }> };

/**
 * A system administrator's override of a willing driver's derived clearance (#544),
 * from anywhere in the conference, with a required note. Self-nomination and a person not currently a willing driver are
 * refused by `recordDriverClearance` itself. Audited.
 */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { personId } = await context.params;
    const actor = await requireGlobalDriverReviewAccess();
    const { clearedToTransport, note } = driverClearanceSchema.parse(await request.json());
    await recordDriverClearance(personId, { clearedToTransport, note }, actor);
    return Response.json({ ok: true });
  } catch (error) {
    return driverVerificationApiError(error, "Recording a driver clearance decision");
  }
}

export const POST = withRequestContext(postHandler);
