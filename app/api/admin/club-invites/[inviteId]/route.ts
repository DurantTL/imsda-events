import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubImportApiError } from "@/modules/club-imports/api-errors";
import { listClubInvites, updateClubInvite } from "@/modules/club-imports/invites";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

const changeSchema = z.union([
  z.object({ email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")) }).strict(),
  z.object({ cancel: z.literal(true) }).strict(),
]);

/** Fix an invite's email (it goes back to waiting) or cancel it. */
async function patchHandler(request: Request, context: { params: Promise<{ inviteId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { inviteId } = await context.params;
    await updateClubInvite(inviteId, changeSchema.parse(await request.json()), actor.id);
    return Response.json({ invites: await listClubInvites() });
  } catch (error) {
    return clubImportApiError(error, "Updating a club invite");
  }
}

export const PATCH = withRequestContext(patchHandler);
