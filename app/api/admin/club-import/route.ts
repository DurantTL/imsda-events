import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubImportApiError } from "@/modules/club-imports/api-errors";
import { importClubs } from "@/modules/club-imports/repository";
import { clubImportConfirmSchema } from "@/modules/club-imports/schemas";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

/** Imports the clubs the administrator confirmed in the preview (#376). Sends nothing. */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { clubs } = clubImportConfirmSchema.parse(await request.json());
    return Response.json({ results: await importClubs(clubs, actor.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubImportApiError(error, "Importing clubs");
  }
}

export const POST = withRequestContext(postHandler);
