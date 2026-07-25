import { z } from "zod";
import {
  AccessDeniedError,
  requireAuthenticatedUser,
} from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import {
  MembershipOperationError,
  setGlobalRole,
} from "@/modules/access/membership-repository";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const globalRoleSchema = z.object({
  globalRole: z.union([z.literal("SYSTEM_ADMIN"), z.null()]),
  eventId: z.string().trim().min(1).max(64).optional(),
});

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_GLOBAL_ROLE", message: "Choose a valid system role." },
      { status: 400 }
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof MembershipOperationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "USER_NOT_FOUND" ? 404 : 409 }
    );
  }
  logError("Global role change failed", error);
  return Response.json(
    { error: "GLOBAL_ROLE_REQUEST_FAILED", message: "The system role could not be changed." },
    { status: 500 }
  );
}

/**
 * Only a system administrator may grant or remove `SYSTEM_ADMIN`. This is what
 * lets a bootstrap account be retired once a real one exists.
 */
async function patchHandler(request: Request, context: { params: Promise<{ userId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  try {
    const actor = requireAuthenticatedUser(await getCurrentSession());
    if (actor.globalRole !== "SYSTEM_ADMIN") {
      throw new AccessDeniedError(
        "System administrator access is required to change a system role.",
        403,
        "PERMISSION_DENIED"
      );
    }

    const { userId } = await context.params;
    const input = globalRoleSchema.parse(await request.json());
    const user = await setGlobalRole(userId, actor.id, input.globalRole, input.eventId);
    return Response.json({ user });
  } catch (error) {
    return apiError(error);
  }
}

export const PATCH = withRequestContext(patchHandler);
