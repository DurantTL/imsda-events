import { withRequestContext } from "@/lib/request-context";
import { instructorApiError, requireInstructorAccount } from "@/modules/honors/instructor-api";
import { getInstructorRoster } from "@/modules/honors/instructor-repository";

/**
 * One class roster for the signed-in instructor (#833): name and club only.
 * 404 for any class that isn't theirs; 403 with the Sterling Volunteers message
 * when their check isn't current. Never cached.
 */
async function getHandler(_request: Request, context: { params: Promise<{ offeringId: string }> }) {
  try {
    const account = await requireInstructorAccount();
    const { offeringId } = await context.params;
    const view = await getInstructorRoster(account.id, offeringId);
    if (view.status === "STERLING_REQUIRED") {
      return Response.json({ error: "STERLING_REQUIRED", message: view.message }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
    }
    return Response.json({ class: view.header, people: view.rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return instructorApiError(error, "Loading a class roster");
  }
}

export const GET = withRequestContext(getHandler);
