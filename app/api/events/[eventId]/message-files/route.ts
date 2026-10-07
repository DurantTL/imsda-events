import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { createMessageFile, listInlineImages, MessageFileError } from "@/modules/communications/message-files";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string }> };

const purposeSchema = z.enum(["attachment", "inline-image"]);

function apiError(error: unknown, operation: string) {
  if (error instanceof MessageFileError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "FILE_TOO_LARGE" ? 413 : error.code === "FILE_NOT_FOUND" ? 404 : 400 },
    );
  }
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

/** The images already uploaded for message bodies, for the editor's picker. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { eventId } = await context.params;
    await authorize(eventId);
    return Response.json({ images: await listInlineImages(eventId) });
  } catch (error) {
    return apiError(error, "Listing the message images");
  }
}

/** One file per request: a message attachment, or an image to place in a message body. */
async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await authorize(eventId);
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return Response.json(
        { error: "FILE_REQUIRED", message: "Choose a file to upload." },
        { status: 400 },
      );
    }
    const purpose = purposeSchema.safeParse(formData.get("purpose") ?? "attachment");
    if (!purpose.success) {
      return Response.json(
        { error: "INVALID_PURPOSE", message: "Upload a file as an attachment or as a message image." },
        { status: 400 },
      );
    }
    const record = await createMessageFile(eventId, file, access.user.id, purpose.data);
    return Response.json({ file: record }, { status: 201 });
  } catch (error) {
    return apiError(error, "Uploading the message file");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
