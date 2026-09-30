import { z } from "zod";
import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { organizationApiError } from "@/modules/organizations/api-errors";
import { EADVENTIST_MAX_BYTES, EADVENTIST_MAX_ROWS } from "@/modules/organizations/eadventist-import";
import { commitEadventistImport, previewEadventistImport } from "@/modules/organizations/eadventist-import-repository";
import { readJsonBody } from "@/modules/organizations/request-body";

const bodySchema = z.object({
  csv: z.string().min(1, "Choose the eAdventist organizations CSV.").max(EADVENTIST_MAX_BYTES),
  confirm: z.boolean(),
  /** "Possible match" choices: eAdventist OrganizationID to a stored organization id, or "NEW". */
  choices: z.record(z.string().max(40), z.string().max(40)).default({}).refine((value) => Object.keys(value).length <= EADVENTIST_MAX_ROWS, "Too many choices."),
}).strict();

/** The CSV plus the JSON around it and the per-row choices. */
const MAX_BODY_CHARS = EADVENTIST_MAX_BYTES + 200_000;

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
    const read = await readJsonBody(request, MAX_BODY_CHARS);
    if ("response" in read) return read.response;
    const { csv, confirm, choices } = bodySchema.parse(read.body);
    const result = confirm ? await commitEadventistImport(csv, actor.id, choices) : await previewEadventistImport(csv, choices);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return organizationApiError(error, "Importing eAdventist organizations");
  }
}

export const POST = withRequestContext(postHandler);
