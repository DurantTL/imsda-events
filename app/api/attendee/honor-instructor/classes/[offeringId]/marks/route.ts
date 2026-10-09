import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { instructorApiError, instructorMarkSchema, requireInstructorAccount } from "@/modules/honors/instructor-api";
import { markInstructorClass } from "@/modules/honors/instructor-repository";

/**
 * One-click ("ALL_ATTENDED", "ALL_COMPLETED", "CLEAR") or per-person ("SET")
 * marks on one of the signed-in instructor's own classes (#833). Completed
 * also marks attended and writes the honor record through the existing
 * Honors Weekend write-back.
 */
async function postHandler(request: Request, context: { params: Promise<{ offeringId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const account = await requireInstructorAccount();
    const { offeringId } = await context.params;
    const input = instructorMarkSchema.parse(await request.json());
    const result = await markInstructorClass(account.id, offeringId, input);
    return Response.json(
      { class: result.view.header, people: result.view.rows, changed: result.changed, locked: result.locked, writeBack: result.writeBack },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return instructorApiError(error, "Saving class marks");
  }
}

export const POST = withRequestContext(postHandler);
