import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { promoCodeApiError } from "@/modules/promo-codes/api-errors";
import { updatePromoCode } from "@/modules/promo-codes/repository";
import { updatePromoCodeInputSchema } from "@/modules/promo-codes/schemas";

export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ eventId: string; promoCodeId: string }>;
  },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, promoCodeId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_FINANCE",
      findActiveMembership,
    );
    const input = updatePromoCodeInputSchema.parse(await request.json());
    const promoCodes = await updatePromoCode(
      eventId,
      promoCodeId,
      input,
      access.user.id,
    );
    return Response.json({ promoCodes });
  } catch (error) {
    return promoCodeApiError(error, "Updating the promo code");
  }
}

