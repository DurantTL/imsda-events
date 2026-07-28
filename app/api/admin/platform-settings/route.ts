import { z } from "zod";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  getPlatformSettings,
  platformSettingsInputSchema,
  updatePlatformSettings,
} from "@/modules/system-admin/platform-settings";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Platform settings are global, so they are gated on the global role directly
 * rather than on an event permission. There is no event to scope them to, and
 * borrowing one event's permission would let its manager change what every
 * other event inherits.
 */
async function requireSystemAdmin() {
  const { user } = await getCurrentSession();
  if (!user || user.globalRole !== "SYSTEM_ADMIN") return null;
  return user;
}

function forbidden() {
  return Response.json(
    {
      error: "SYSTEM_ADMIN_REQUIRED",
      message: "Only a system administrator can change platform settings.",
    },
    { status: 403 },
  );
}

async function getHandler() {
  const user = await requireSystemAdmin();
  if (!user) return forbidden();
  return Response.json({ settings: await getPlatformSettings() });
}

async function patchHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const user = await requireSystemAdmin();
  if (!user) return forbidden();
  try {
    const input = platformSettingsInputSchema.parse(await request.json());
    return Response.json({ settings: await updatePlatformSettings(input, user.id) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          error: "INVALID_PLATFORM_SETTINGS",
          message: error.issues[0]?.message ?? "Review the settings and try again.",
          issues: error.issues,
        },
        { status: 400 },
      );
    }
    if (error instanceof SyntaxError) {
      return Response.json(
        { error: "INVALID_JSON", message: "The request is not valid JSON." },
        { status: 400 },
      );
    }
    logError("Updating platform settings failed", error);
    return Response.json(
      {
        error: "PLATFORM_SETTINGS_UPDATE_FAILED",
        message: "The platform settings could not be saved.",
      },
      { status: 500 },
    );
  }
}

export const GET = withRequestContext(getHandler);
export const PATCH = withRequestContext(patchHandler);
