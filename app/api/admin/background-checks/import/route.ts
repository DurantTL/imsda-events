import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import {
  detectBackgroundCsvFormat,
  MAX_ROSTER_CSV_BYTES,
  MAX_STERLING_CSV_BYTES,
  parseRosterBackgroundCsv,
  parseSterlingCsv,
  RosterBackgroundCsvError,
  SterlingCsvError,
} from "@/modules/background-checks/domain";
import {
  applyRosterBackgroundImport,
  applySterlingImport,
  planRosterBackgroundImport,
  planSterlingImport,
} from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

const importSchema = z.object({
  csv: z.string().max(Math.max(MAX_ROSTER_CSV_BYTES, MAX_STERLING_CSV_BYTES), "That file is too large."),
  confirm: z.boolean().default(false),
}).strict();

/**
 * Background check CSV upload (#388, #427): preview, then record on confirm.
 * Accepts the real roster export (`user_id,user_last,user_first,roles,sites,
 * user_active,compliance,issues`, matched by name and location) and the older
 * Sterling Volunteers export (matched by email or birth date), detected from
 * the header row. The file is read in memory and never stored.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { csv, confirm } = importSchema.parse(await request.json());
    const format = detectBackgroundCsvFormat(csv);

    if (format === "ROSTER") {
      let rows;
      try {
        rows = parseRosterBackgroundCsv(csv);
      } catch (error) {
        if (error instanceof RosterBackgroundCsvError) return Response.json({ error: "INVALID_ROSTER_CSV", message: error.message }, { status: 400 });
        throw error;
      }
      const plan = await planRosterBackgroundImport(rows);
      const steps = plan.map(({ line, name, action, message, candidates }) => ({ line, name, action, message, candidates }));
      if (!confirm) return Response.json({ format, steps });
      const result = await applyRosterBackgroundImport(plan, actor.id);
      return Response.json({
        format,
        steps: steps.map((step) => ({ ...step, message: step.action === "ADD" || step.action === "UPDATE" ? `Recorded. ${step.message}` : step.message })),
        ...result,
      });
    }

    let rows;
    try {
      rows = parseSterlingCsv(csv);
    } catch (error) {
      if (error instanceof SterlingCsvError) return Response.json({ error: "INVALID_STERLING_CSV", message: error.message }, { status: 400 });
      throw error;
    }
    const plan = await planSterlingImport(rows);
    const steps = plan.map(({ line, name, action, message }) => ({ line, name, action, message }));
    if (!confirm) return Response.json({ format, steps });
    const result = await applySterlingImport(plan, actor.id);
    return Response.json({
      format,
      steps: steps.map((step) => ({ ...step, message: step.action === "SKIP" ? step.message : `Recorded. ${step.message}` })),
      ...result,
    });
  } catch (error) {
    return backgroundCheckApiError(error, "Uploading background checks");
  }
}

export const POST = withRequestContext(postHandler);
