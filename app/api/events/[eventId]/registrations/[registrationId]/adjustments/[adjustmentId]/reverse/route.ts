import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { reverseAdjustmentSchema, reverseRegistrationAdjustment } from "@/modules/registrations/adjustments";
import { adjustmentApiError } from "@/modules/registrations/adjustments-api";
import { withRequestContext } from "@/lib/request-context";

/** Cancels an adjustment with an opposite line (#396). */
async function postHandler(
  request: Request,
  context: { params: Promise<{ eventId: string; registrationId: string; adjustmentId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId, adjustmentId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const { reason } = reverseAdjustmentSchema.parse(await request.json());
    const registration = await reverseRegistrationAdjustment(eventId, registrationId, adjustmentId, access.user.id, reason);
    return Response.json({ registration });
  } catch (error) {
    return adjustmentApiError(error, "Reversing a registration adjustment");
  }
}

export const POST = withRequestContext(postHandler);
