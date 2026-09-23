import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { honorApiError } from "@/modules/honors/api-errors";
import { requireHonorPermission } from "@/modules/honors/access";
import { applyHonorCopy, previewHonorCopy } from "@/modules/honors/copy";
import { honorCopyInputSchema } from "@/modules/honors/schemas";
import { withRequestContext } from "@/lib/request-context";

/**
 * Without a fingerprint this previews the copy and writes nothing. With the
 * fingerprint from that preview it applies exactly what was reviewed.
 */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requireHonorPermission(eventId);
    const input = honorCopyInputSchema.parse(await request.json());
    await requireHonorPermission(input.sourceEventId, "VIEW_EVENT");
    if (!input.fingerprint) {
      return Response.json({ plan: await previewHonorCopy(eventId, input.sourceEventId) });
    }
    return Response.json(
      await applyHonorCopy(eventId, input.sourceEventId, input.fingerprint, access.user.id),
    );
  } catch (error) {
    return honorApiError(error, "Copying honor offerings");
  }
}

export const POST = withRequestContext(postHandler);
