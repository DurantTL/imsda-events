import { requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { archiveVariant, updateVariant } from "@/modules/merchandise/catalog-repository";
import { withRequestContext } from "@/lib/request-context";

type Context = { params: Promise<{ eventId: string; productId: string; variantId: string }> };

export const PATCH = withRequestContext(async (request: Request, context: Context) => {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, productId, variantId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json({ variant: await updateVariant(eventId, productId, variantId, await request.json(), access.user.id) });
  } catch (error) {
    if (error instanceof Error && "status" in error) return Response.json({ error: (error as Error & { code?: string }).code ?? "ACCESS_DENIED", message: error.message }, { status: Number((error as Error & { status: number }).status) });
    if (error instanceof SyntaxError) return Response.json({ error: "INVALID_JSON", message: "The request is not valid JSON." }, { status: 400 });
    return Response.json({ error: "MERCHANDISE_VARIANT_FAILED", message: error instanceof Error ? error.message : "The variant request could not be completed." }, { status: 400 });
  }
});

export const DELETE = withRequestContext(async (request: Request, context: Context) => {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, variantId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "CONFIGURE_EVENT", findActiveMembership);
    return Response.json({ variant: await archiveVariant(eventId, variantId, access.user.id) });
  } catch (error) {
    if (error instanceof Error && "status" in error) return Response.json({ error: (error as Error & { code?: string }).code ?? "ACCESS_DENIED", message: error.message }, { status: Number((error as Error & { status: number }).status) });
    return Response.json({ error: "MERCHANDISE_VARIANT_FAILED", message: error instanceof Error ? error.message : "The variant request could not be completed." }, { status: 400 });
  }
});
