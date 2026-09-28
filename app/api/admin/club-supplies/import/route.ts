import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubSupplyApiError } from "@/modules/club-supplies/api-errors";
import { type ClubSupplyImportPlan, ClubSupplyCsvError, parseClubSupplyCsv } from "@/modules/club-supplies/catalog-csv";
import { applyClubSupplyImport, previewClubSupplyImport } from "@/modules/club-supplies/repository";
import { clubSupplyImportSchema } from "@/modules/club-supplies/schemas";
import { requireSystemAdministrator } from "@/modules/organizations/access";

function publicPlan(plan: ClubSupplyImportPlan) {
  return {
    steps: plan.steps.map(({ line, name, action, message, section, honorMatch, duplicateOfLine }) => ({
      line, name, action, message, section, honorMatch, duplicateOfLine,
    })),
    summary: plan.summary,
    repeatedNumbers: plan.repeatedNumbers,
    mergedNumberConflicts: plan.mergedNumberConflicts,
  };
}

/**
 * Club supply catalog CSV import (#531): `confirm: false` is the dry run and
 * returns a fingerprint; `confirm: true` must send that fingerprint back, or
 * nothing is saved (409 `PREVIEW_CHANGED`).
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { csv, confirm, fingerprint } = clubSupplyImportSchema.parse(await request.json());
    let rows;
    try {
      rows = parseClubSupplyCsv(csv);
    } catch (error) {
      if (error instanceof ClubSupplyCsvError) {
        return Response.json({ error: "INVALID_CLUB_SUPPLY_CSV", message: error.message }, { status: 400 });
      }
      throw error;
    }
    if (!confirm) {
      const preview = await previewClubSupplyImport(rows);
      return Response.json({ ...publicPlan(preview.plan), fingerprint: preview.fingerprint });
    }
    if (!fingerprint) {
      return Response.json(
        { error: "PREVIEW_CHANGED", message: "Run the preview first, then confirm what it shows." },
        { status: 409 },
      );
    }
    const result = await applyClubSupplyImport(rows, fingerprint, actor.id);
    return Response.json({ ...publicPlan(result), items: result.items });
  } catch (error) {
    return clubSupplyApiError(error, "Importing the club supply catalog");
  }
}

export const POST = withRequestContext(postHandler);
