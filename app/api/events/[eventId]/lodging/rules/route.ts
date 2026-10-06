import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { lodgingApiError } from "@/modules/lodging/api-errors";
import { ruleActionSchema } from "@/modules/lodging/preferences-domain";
import { createLodgingRule, endLodgingRule, getStaffLodgingRequestsView } from "@/modules/lodging/preferences-service";
import { requireLodgingStaff } from "@/modules/lodging/staff-access";
import { withRequestContext } from "@/lib/request-context";

/** Staff add or end a keep-together, split or keep-apart rule. Rules are ended with a reason, never deleted. */
async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const staff = await requireLodgingStaff(eventId, "MANAGE_REGISTRATION");
    const body = ruleActionSchema.parse(await request.json());
    if (body.action === "acknowledge") {
      throw new z.ZodError([{ code: "custom", message: "Acknowledge review items through the requests route.", path: ["action"], input: body.action }]);
    }
    const result = body.action === "create"
      ? await createLodgingRule(eventId, staff.userId, body.rule)
      : await endLodgingRule(eventId, staff.userId, body.ruleId, body.reason);
    return Response.json(
      { result, requests: await getStaffLodgingRequestsView(eventId, { canSeeSensitive: staff.canSeeSensitive }) },
      { status: body.action === "create" ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return lodgingApiError(error, "Saving the lodging rule");
  }
}

export const POST = withRequestContext(postHandler);
