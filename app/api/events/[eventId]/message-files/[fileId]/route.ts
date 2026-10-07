import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { deleteMessageFileIfUnused, findMessageFileForStaff } from "@/modules/communications/message-files";
import { eventAssetResponse } from "@/modules/events/asset-response";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string; fileId: string }> };

function apiError(error: unknown, operation: string) {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  logError(`${operation} failed`, error);
  return Response.json(
    { error: "MESSAGE_FILE_FAILED", message: `${operation} could not be completed.` },
    { status: 500 },
  );
}

async function authorize(eventId: string) {
  return requirePermission(
    await getCurrentSession(),
    eventId,
    "MANAGE_COMMUNICATIONS",
    findActiveMembership,
  );
}

/**
 * A stored message file, to staff who can manage this event's communications and nobody else. The file is looked
 * up by event as well as id, so one event's staff cannot open another event's file by guessing an id. It is always
 * served under the type its bytes were verified to have at upload.
 */
async function getHandler(request: Request, context: RouteContext) {
  try {
    const { eventId, fileId } = await context.params;
    await authorize(eventId);
    const file = await findMessageFileForStaff(eventId, fileId);
    if (!file) {
      return Response.json(
        { error: "FILE_NOT_FOUND", message: "That file is no longer available." },
        { status: 404 },
      );
    }
    const disposition = new URL(request.url).searchParams.get("disposition") === "inline" ? "inline" : "attachment";
    return await eventAssetResponse(
      { displayName: file.filename, contentType: file.contentType, storageKey: file.storageKey },
      disposition,
    );
  } catch (error) {
    return apiError(error, "Opening the message file");
  }
}

/** Removes an uploaded attachment nothing uses yet. A file a template, announcement or sent message refers to stays. */
async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, fileId } = await context.params;
    await authorize(eventId);
    const file = await findMessageFileForStaff(eventId, fileId);
    // An image a body embeds is never deleted here: the body refers to it by id.
    if (!file || file.isInlineImage) {
      return Response.json(
        { error: "FILE_NOT_FOUND", message: "That file is no longer available." },
        { status: 404 },
      );
    }
    return Response.json({ removed: await deleteMessageFileIfUnused(eventId, fileId) });
  } catch (error) {
    return apiError(error, "Removing the message file");
  }
}

export const GET = withRequestContext(getHandler);
export const DELETE = withRequestContext(deleteHandler);
