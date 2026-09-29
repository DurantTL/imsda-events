import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { matchRejectedBackgroundCheckPairing } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

const bodySchema = z.object({ entryId: z.string().min(1), personId: z.string().min(1) });

/**
 * "Match them anyway" (#598): staff match a person they earlier said a row is
 * not, by hand. A staff match that clears the rejection. 400 for a pair staff
 * never rejected, 404 for a row that's gone, 409 while the list is busy.
 * Staff-only.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { entryId, personId } = bodySchema.parse(await request.json());
    await matchRejectedBackgroundCheckPairing(entryId, personId, actor.id);
    return Response.json({ ok: true });
  } catch (error) {
    return backgroundCheckApiError(error, "Matching a rejected background check pair by hand");
  }
}

export const POST = withRequestContext(postHandler);
