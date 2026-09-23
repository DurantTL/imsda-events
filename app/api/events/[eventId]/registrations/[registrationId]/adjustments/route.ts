import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { createAdjustmentSchema, createRegistrationAdjustment } from "@/modules/registrations/adjustments";
import { adjustmentApiError } from "@/modules/registrations/adjustments-api";
import { withRequestContext } from "@/lib/request-context";

/** Adds a scholarship, discount, late promo code, or correction (#396). */
async function postHandler(
  request: Request,
  context: { params: Promise<{ eventId: string; registrationId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const input = createAdjustmentSchema.parse(await request.json());
    const registration = await createRegistrationAdjustment(eventId, registrationId, access.user.id, input);
    return Response.json({ registration }, { status: 201 });
  } catch (error) {
    return adjustmentApiError(error, "Adding a registration adjustment");
  }
}

export const POST = withRequestContext(postHandler);
