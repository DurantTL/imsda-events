import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { MAX_STERLING_CSV_BYTES, parseSterlingCsv, SterlingCsvError } from "@/modules/background-checks/domain";
import { applySterlingImport, planSterlingImport } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

const importSchema = z.object({
  csv: z.string().max(MAX_STERLING_CSV_BYTES, "That file is too large. Upload up to 2,000 people at a time."),
  confirm: z.boolean().default(false),
}).strict();

/**
 * Sterling Volunteers CSV upload (#388): preview, then record on confirm. The
 * file is read in memory and never stored; only matched people's dates are.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { csv, confirm } = importSchema.parse(await request.json());
    let rows;
    try {
      rows = parseSterlingCsv(csv);
    } catch (error) {
      if (error instanceof SterlingCsvError) return Response.json({ error: "INVALID_STERLING_CSV", message: error.message }, { status: 400 });
      throw error;
    }
    const plan = await planSterlingImport(rows);
    const steps = plan.map(({ line, name, action, message }) => ({ line, name, action, message }));
    if (!confirm) return Response.json({ steps });
    const result = await applySterlingImport(plan, actor.id);
    return Response.json({
      steps: steps.map((step) => ({ ...step, message: step.action === "SKIP" ? step.message : `Recorded. ${step.message}` })),
      ...result,
    });
  } catch (error) {
    return backgroundCheckApiError(error, "Uploading background checks");
  }
}

export const POST = withRequestContext(postHandler);
