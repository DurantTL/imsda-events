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
  rosterRowToListRow,
  RosterBackgroundCsvError,
  sterlingRowToListRow,
  SterlingCsvError,
} from "@/modules/background-checks/domain";
import { applyBackgroundCheckUpload, planBackgroundCheckUpload } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

const importSchema = z.object({
  csv: z.string().max(Math.max(MAX_ROSTER_CSV_BYTES, MAX_STERLING_CSV_BYTES), "That file is too large."),
  confirm: z.boolean().default(false),
}).strict();

/**
 * Background check CSV upload (#388, #427, #527): preview the counts an
 * upload would change, then replace the list on confirm. Accepts the real
 * roster export (`user_id,user_last,user_first,roles,sites,user_active,
 * compliance,issues`) and the older Sterling Volunteers export, detected
 * from the header row; both feed the same stored list. The file is read in
 * memory and never stored — only the parsed rows are. Matching a row to a
 * person happens afterward, at lookup, not here.
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
      const problems = rows.filter((row) => row.problems.length > 0).map((row) => ({ line: row.line, name: `${row.firstName} ${row.lastName}`.trim(), problems: row.problems }));
      const listRows = rows.filter((row) => row.problems.length === 0).map(rosterRowToListRow);
      if (!confirm) {
        const counts = await planBackgroundCheckUpload(listRows);
        return Response.json({ format, problems, ...counts });
      }
      const counts = await applyBackgroundCheckUpload(listRows, format, actor.id);
      return Response.json({ format, problems, ...counts });
    }

    let rows;
    try {
      rows = parseSterlingCsv(csv);
    } catch (error) {
      if (error instanceof SterlingCsvError) return Response.json({ error: "INVALID_STERLING_CSV", message: error.message }, { status: 400 });
      throw error;
    }
    const problems = rows.filter((row) => row.problems.length > 0).map((row) => ({ line: row.line, name: `${row.firstName} ${row.lastName}`.trim(), problems: row.problems }));
    const listRows = rows.filter((row) => row.problems.length === 0).map(sterlingRowToListRow);
    if (!confirm) {
      const counts = await planBackgroundCheckUpload(listRows);
      return Response.json({ format, problems, ...counts });
    }
    const counts = await applyBackgroundCheckUpload(listRows, format, actor.id);
    return Response.json({ format, problems, ...counts });
  } catch (error) {
    return backgroundCheckApiError(error, "Uploading background checks");
  }
}

export const POST = withRequestContext(postHandler);
