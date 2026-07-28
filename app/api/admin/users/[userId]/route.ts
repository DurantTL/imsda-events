import { z } from "zod";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  AccountStatusError,
  setAccountDisabled,
} from "@/modules/system-admin/account-status";
import { getTeamDirectory } from "@/modules/system-admin/team-directory";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const inputSchema = z.object({ disabled: z.boolean() }).strict();

/**
 * Sign-in is platform-wide, so this is gated on the global role rather than an
 * event permission. An event manager may remove someone from their own event;
 * only a system administrator decides whether that person can sign in at all.
 */
async function patchHandler(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const { user } = await getCurrentSession();
  if (!user || user.globalRole !== "SYSTEM_ADMIN") {
    return Response.json(
      {
        error: "SYSTEM_ADMIN_REQUIRED",
        message: "Only a system administrator can change whether an account can sign in.",
      },
      { status: 403 },
    );
  }
  try {
    const { userId } = await context.params;
    const input = inputSchema.parse(await request.json());
    await setAccountDisabled(userId, input.disabled, user.id);
    return Response.json({ directory: await getTeamDirectory() });
  } catch (error) {
    if (error instanceof AccountStatusError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.code === "ACCOUNT_NOT_FOUND" ? 404 : 409 },
      );
    }
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "INVALID_REQUEST", message: "Say whether the account should be disabled." },
        { status: 400 },
      );
    }
    logError("Changing an account's sign-in failed", error);
    return Response.json(
      { error: "ACCOUNT_STATUS_FAILED", message: "That account could not be updated." },
      { status: 500 },
    );
  }
}

export const PATCH = withRequestContext(patchHandler);
