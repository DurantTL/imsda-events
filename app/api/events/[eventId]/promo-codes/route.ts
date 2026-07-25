import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { promoCodeApiError } from "@/modules/promo-codes/api-errors";
import {
  createPromoCode,
  listPromoCodes,
} from "@/modules/promo-codes/repository";
import { promoCodeInputSchema } from "@/modules/promo-codes/schemas";
import { withRequestContext } from "@/lib/request-context";

async function getHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_FINANCE",
      findActiveMembership,
    );
    return Response.json({ promoCodes: await listPromoCodes(eventId) });
  } catch (error) {
    return promoCodeApiError(error, "Loading promo codes");
  }
}

async function postHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_FINANCE",
      findActiveMembership,
    );
    const input = promoCodeInputSchema.parse(await request.json());
    const promoCodes = await createPromoCode(
      eventId,
      input,
      access.user.id,
    );
    return Response.json({ promoCodes }, { status: 201 });
  } catch (error) {
    return promoCodeApiError(error, "Creating the promo code");
  }
}


export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
