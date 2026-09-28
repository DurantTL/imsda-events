import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { earnedAwardApiError } from "@/modules/earned-awards/api-errors";
import { updateMasterAwardRule } from "@/modules/earned-awards/rules-repository";
import { masterAwardRuleUpdateSchema } from "@/modules/earned-awards/schemas";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/**
 * Edits one Master Award rule (#532): its honor groups and minimums, its
 * catalog item, its note, the manual-check flag, or its status (activate,
 * deactivate). System administrators only; every change is audited. A rule
 * can't be ACTIVE until it's checked and every group's minimum is reachable.
 */
async function patchHandler(request: Request, context: { params: Promise<{ ruleId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { ruleId } = await context.params;
    const patch = masterAwardRuleUpdateSchema.parse(await request.json());
    return Response.json({ rules: await updateMasterAwardRule(ruleId, patch, actor.id) });
  } catch (error) {
    return earnedAwardApiError(error, "Updating a Master Award rule");
  }
}

export const PATCH = withRequestContext(patchHandler);
