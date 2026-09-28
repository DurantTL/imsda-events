import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubImportApiError } from "@/modules/club-imports/api-errors";
import { moveImportYear, previewImportYearMove } from "@/modules/club-imports/move-year";
import { importYearMoveSchema } from "@/modules/club-imports/schemas";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

/**
 * "Move this import to another club year" (#541), system administrators only.
 * `mode: "preview"` returns the counts and any conflicts and changes nothing;
 * `mode: "move"` checks again and moves, or refuses with the conflicts (409).
 */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const { fromYear, toYear, mode } = importYearMoveSchema.parse(await request.json());
    const body = mode === "preview"
      ? { preview: await previewImportYearMove(organizationId, fromYear, toYear) }
      : { moved: await moveImportYear(organizationId, fromYear, toYear, actor.id) };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubImportApiError(error, "Moving the club import");
  }
}

export const POST = withRequestContext(postHandler);
