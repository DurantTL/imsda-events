import { AccessDeniedError } from "@/modules/access/authorization";
import { withRequestContext } from "@/lib/request-context";
import { newClubApplicationApiError } from "@/modules/club-applications/api-errors";
import { getApplicationAttachment } from "@/modules/club-applications/repository";
import { currentApplicationViewer } from "@/modules/club-applications/viewer";
import { eventAssetResponse } from "@/modules/events/asset-response";

/**
 * An application's attachment (#817), the signed paper page or the church board
 * minutes. System administrators and Area Coordinators only; anyone else gets
 * the same 404 as a missing file, so nothing says whether one exists. Always
 * served as a download, with the type verified when it was uploaded.
 */
async function getHandler(_request: Request, context: { params: Promise<{ applicationId: string }> }) {
  try {
    const { applicationId } = await context.params;
    const viewer = await currentApplicationViewer();
    if (!viewer) return Response.json({ message: "Not found." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    const attachment = await getApplicationAttachment(viewer, applicationId);
    if (!attachment) return Response.json({ message: "Not found." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    const response = await eventAssetResponse(attachment, "attachment");
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ message: "Not found." }, { status: 404 });
    return newClubApplicationApiError(error, "Downloading a new club application attachment");
  }
}

export const GET = withRequestContext(getHandler);
