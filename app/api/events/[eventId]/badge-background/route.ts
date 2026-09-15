import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  BadgeBackgroundError,
  getEventBadgeBackground,
  listBadgeBackgroundOptions,
  setEventBadgeBackground,
} from "@/modules/checkin/badge-background-repository";
import { eventAssetResponse } from "@/modules/events/asset-response";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventId: string }> };

const badgeBackgroundInputSchema = z.strictObject({
  assetId: z.string().trim().min(1).max(64).nullable(),
});

function apiError(error: unknown, operation: string) {
  if (error instanceof BadgeBackgroundError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "ASSET_NOT_FOUND" ? 404 : 400 },
    );
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_INPUT", message: "Choose an uploaded image, or clear the background." },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  logError(`${operation} failed`, error);
  return Response.json(
    { error: "BADGE_BACKGROUND_FAILED", message: `${operation} could not be completed.` },
    { status: 500 },
  );
}

/**
 * Printing badges is what needs the picture, so check-in staff may read it
 * even though the file library itself is event configuration. Choosing it
 * still takes CONFIGURE_EVENT, the same permission the upload does.
 */
async function authorizeRead(eventId: string) {
  return requirePermission(
    await getCurrentSession(),
    eventId,
    "MANAGE_CHECK_IN",
    findActiveMembership,
  );
}

async function authorizeWrite(eventId: string) {
  return requirePermission(
    await getCurrentSession(),
    eventId,
    "CONFIGURE_EVENT",
    findActiveMembership,
  );
}

/** Serves the image itself so a badge sheet can render it, or lists the
 * images available to choose from when asked for JSON. */
async function getHandler(request: Request, context: RouteContext) {
  try {
    const { eventId } = await context.params;
    await authorizeRead(eventId);
    const wantsOptions = new URL(request.url).searchParams.get("options") === "true";
    const background = await getEventBadgeBackground(eventId);
    if (wantsOptions) {
      await authorizeWrite(eventId);
      return Response.json({
        background: background
          ? { id: background.id, displayName: background.displayName, url: background.url }
          : null,
        options: await listBadgeBackgroundOptions(eventId),
      });
    }
    if (!background) {
      return Response.json(
        { error: "NO_BADGE_BACKGROUND", message: "This event has no name badge background." },
        { status: 404 },
      );
    }
    return eventAssetResponse(background, "inline");
  } catch (error) {
    return apiError(error, "Opening the name badge background");
  }
}

async function putHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await authorizeWrite(eventId);
    const input = badgeBackgroundInputSchema.parse(await request.json());
    const background = await setEventBadgeBackground(
      eventId,
      input.assetId,
      access.user.id,
    );
    return Response.json({
      background: background
        ? { id: background.id, displayName: background.displayName, url: background.url }
        : null,
      options: await listBadgeBackgroundOptions(eventId),
    });
  } catch (error) {
    return apiError(error, "Saving the name badge background");
  }
}

export const GET = withRequestContext(getHandler);
export const PUT = withRequestContext(putHandler);
