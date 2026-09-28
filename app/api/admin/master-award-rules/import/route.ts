import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { earnedAwardApiError } from "@/modules/earned-awards/api-errors";
import { parseMasterAwardRulesFile } from "@/modules/earned-awards/master-award-import";
import { applyMasterAwardRulesImport, previewMasterAwardRulesImport } from "@/modules/earned-awards/rules-repository";
import { masterAwardRulesImportSchema } from "@/modules/earned-awards/schemas";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/**
 * Master Award rules import (#532): `confirm: false` is the dry run (rules
 * to add, honors matched and unmatched, rules flagged for a manual check) and
 * returns a fingerprint; `confirm: true` must send it back, or nothing is
 * saved (409 `PREVIEW_CHANGED`). New rules arrive as DRAFT. System
 * administrators only.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { json, confirm, fingerprint } = masterAwardRulesImportSchema.parse(await request.json());
    const seeds = parseMasterAwardRulesFile(json);
    if (!confirm) {
      const preview = await previewMasterAwardRulesImport(seeds);
      return Response.json({ ...preview.plan, fingerprint: preview.fingerprint });
    }
    if (!fingerprint) {
      return Response.json({ error: "PREVIEW_CHANGED", message: "Run the preview first, then confirm what it shows." }, { status: 409 });
    }
    const result = await applyMasterAwardRulesImport(seeds, fingerprint, actor.id);
    return Response.json(result);
  } catch (error) {
    return earnedAwardApiError(error, "Importing Master Award rules");
  }
}

export const POST = withRequestContext(postHandler);
