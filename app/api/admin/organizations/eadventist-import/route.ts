import { z } from "zod";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { EADVENTIST_MAX_BYTES } from "@/modules/organizations/eadventist-import";
import { commitEadventistImport, previewEadventistImport } from "@/modules/organizations/eadventist-import-repository";

const bodySchema = z.object({ csv: z.string().min(1, "Choose the eAdventist organizations CSV.").max(EADVENTIST_MAX_BYTES), confirm: z.boolean() }).strict();

/**
 * The eAdventist organizations import (#649): `{ csv, confirm: false }`
 * previews, `{ csv, confirm: true }` saves. System administrators only. The
 * file is parsed in memory; it is never stored, and errors never log it.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { csv, confirm } = bodySchema.parse(await request.json());
    const result = confirm ? await commitEadventistImport(csv, actor.id) : await previewEadventistImport(csv);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return organizationApiError(error, "Importing eAdventist organizations");
  }
}

export const POST = withRequestContext(postHandler);
