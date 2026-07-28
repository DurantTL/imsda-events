import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  EventAssetError,
  findEventAssetForStaff,
  listEventAssets,
  removeEventAsset,
} from "@/modules/events/asset-repository";
import { eventAssetResponse } from "@/modules/events/asset-response";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string; assetId: string }> };

async function authorize(eventId: string) {
  return requirePermission(
    await getCurrentSession(),
    eventId,
    "CONFIGURE_EVENT",
    findActiveMembership,
  );
}

function apiError(error: unknown, operation: string) {
  if (error instanceof EventAssetError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "ASSET_NOT_FOUND" ? 404 : error.code === "ASSET_IN_USE" ? 409 : 400 },
    );
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

/** Staff preview, including files no published section links to yet. */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { eventId, assetId } = await context.params;
    await authorize(eventId);
    const asset = await findEventAssetForStaff(eventId, assetId);
    if (!asset) {
      return Response.json(
        { error: "ASSET_NOT_FOUND", message: "That file is no longer available." },
        { status: 404 },
      );
    }
    return eventAssetResponse(asset);
  } catch (error) {
    return apiError(error, "Opening the event file");
  }
}

async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, assetId } = await context.params;
    await authorize(eventId);
    await removeEventAsset(eventId, assetId);
    return Response.json({ assets: await listEventAssets(eventId) });
  } catch (error) {
    return apiError(error, "Deleting the event file");
  }
}

export const GET = withRequestContext(getHandler);
export const DELETE = withRequestContext(deleteHandler);
