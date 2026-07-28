import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  createEventAsset,
  EventAssetError,
  listEventAssets,
} from "@/modules/events/asset-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string }> };

function apiError(error: unknown, operation: string) {
  if (error instanceof EventAssetError) {
    const status = error.code === "ASSET_TOO_LARGE"
      ? 413
      : error.code === "ASSET_NOT_FOUND"
        ? 404
        : error.code === "ASSET_IN_USE"
          ? 409
          : 400;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  logError(`${operation} failed`, error);
  return Response.json(
    { error: "EVENT_ASSET_FAILED", message: `${operation} could not be completed.` },
    { status: 500 },
  );
}

async function authorize(eventId: string) {
  return requirePermission(
    await getCurrentSession(),
    eventId,
    "CONFIGURE_EVENT",
    findActiveMembership,
  );
}

async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { eventId } = await context.params;
    await authorize(eventId);
    return Response.json({ assets: await listEventAssets(eventId) });
  } catch (error) {
    return apiError(error, "Listing the event files");
  }
}

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
        { error: "ASSET_REQUIRED", message: "Choose a file to upload." },
        { status: 400 },
      );
    }
    const asset = await createEventAsset(eventId, file, access.user.id);
    return Response.json({ asset, assets: await listEventAssets(eventId) }, { status: 201 });
  } catch (error) {
    return apiError(error, "Uploading the event file");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
