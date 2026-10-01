import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { HealthAccessGrantError, setHealthAccess } from "@/modules/coordinator-health/membership-grants";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const bodySchema = z.object({ granted: z.boolean() });

/** Only a system administrator grants or revokes the health information permission (#658). */
async function putHandler(request: Request, context: { params: Promise<{ eventId: string; membershipId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, membershipId } = await context.params;
    const { user } = await getCurrentSession();
    if (!user) throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
    if (user.globalRole !== "SYSTEM_ADMIN") throw new AccessDeniedError("Only a system administrator can change health information access.", 403, "PERMISSION_DENIED");
    const { granted } = bodySchema.parse(await request.json());
    const result = await setHealthAccess(eventId, membershipId, user.id, granted);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "INVALID_REQUEST", message: "Send { granted: true or false }." }, { status: 400 });
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof HealthAccessGrantError) return Response.json({ error: error.code, message: error.message }, { status: 404 });
    logError("Health access change failed", error);
    return Response.json({ error: "HEALTH_ACCESS_FAILED", message: "The access change could not be saved." }, { status: 500 });
  }
}

export const PUT = withRequestContext(putHandler);
