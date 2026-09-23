import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { honorApiError } from "@/modules/honors/api-errors";
import { HonorCsvError, MAX_HONOR_CSV_BYTES, parseHonorCsv, planHonorImport } from "@/modules/honors/catalog-csv";
import { applyHonorImport, listHonors } from "@/modules/honors/repository";
import { withRequestContext } from "@/lib/request-context";

const importSchema = z.object({
  csv: z.string().max(MAX_HONOR_CSV_BYTES, "That file is too large. Import up to 2,000 honors at a time."),
  confirm: z.boolean().default(false),
}).strict();

/** Honor catalog CSV import (#385): preview, then save on confirm. */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { csv, confirm } = importSchema.parse(await request.json());
    let rows;
    try {
      rows = parseHonorCsv(csv);
    } catch (error) {
      if (error instanceof HonorCsvError) return Response.json({ error: "INVALID_HONOR_CSV", message: error.message }, { status: 400 });
      throw error;
    }
    const existing = (await listHonors()).map((honor) => ({
      id: honor.id, code: honor.code, name: honor.name, description: honor.description, isActive: honor.isActive,
    }));
    const plan = planHonorImport(rows, existing);
    const steps = plan.map(({ line, name, action, message }) => ({ line, name, action, message }));
    if (!confirm) return Response.json({ steps });
    const result = await applyHonorImport(plan, actor.id);
    return Response.json({
      steps: steps.map((step) => ({ ...step, message: step.action === "ADD" ? "Added." : step.action === "UPDATE" ? "Updated." : step.message })),
      ...result,
    });
  } catch (error) {
    return honorApiError(error, "Importing the honor catalog");
  }
}

export const POST = withRequestContext(postHandler);
