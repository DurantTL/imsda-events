import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { staffCommunityActionSchema } from "@/modules/community/domain";
import {
  CommunityError,
  moderateCommunityPost,
  resolveCommunityReport,
  updateCommunitySettings,
} from "@/modules/community/repository";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({
      error: "INVALID_COMMUNITY_ACTION",
      message: error.issues[0]?.message ?? "Review the community settings and try again.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof CommunityError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  logError("Staff community request failed", error);
  return Response.json({
    error: "COMMUNITY_REQUEST_FAILED",
    message: "The community action could not be completed.",
  }, { status: 500 });
}

async function patchHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_COMMUNICATIONS",
      findActiveMembership,
    );
    const input = staffCommunityActionSchema.parse(await request.json());
    switch (input.action) {
      case "UPDATE_SETTINGS":
        await updateCommunitySettings(eventId, access.user.id, input);
        break;
      case "MODERATE_POST":
        await moderateCommunityPost(eventId, access.user.id, input);
        break;
      case "RESOLVE_REPORT":
        await resolveCommunityReport(eventId, access.user.id, input);
        break;
    }
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

export const PATCH = withRequestContext(patchHandler);
