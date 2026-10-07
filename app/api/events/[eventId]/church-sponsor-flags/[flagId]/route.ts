import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { ChurchSponsorFlagError, clearChurchSponsorFlag } from "@/modules/promo-codes/church-sponsor-lodging";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * The finance office clears a church-sponsorship flag (#813) once they have dealt with it. MANAGE_FINANCE on the event in
 * the URL; same-origin only. Clearing changes no amount and no invoice. It only takes the flag off the finance screens.
 */
const bodySchema = z.object({ note: z.string().trim().max(300).optional() });

async function postHandler(request: Request, context: { params: Promise<{ eventId: string; flagId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, flagId } = await context.params;
    const { user } = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const cleared = await clearChurchSponsorFlag({ eventId, flagId, actorUserId: user.id, note: body.note ?? null });
    return Response.json({ cleared: true, id: cleared.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof ChurchSponsorFlagError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "FLAG_NOT_FOUND" ? 404 : 409 });
    if (error instanceof z.ZodError) return Response.json({ error: "INVALID_INPUT", message: "Check the note and try again." }, { status: 400 });
    logError("Unable to clear a church sponsorship flag", error);
    return Response.json({ error: "CHURCH_SPONSOR_FLAG_FAILED" }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
