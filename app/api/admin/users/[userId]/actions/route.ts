import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { getTeamDirectory } from "@/modules/system-admin/team-directory";
import { changeStaffEmail, resetStaffTwoStep, sendStaffPasswordReset } from "@/modules/system-admin/user-admin";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset-two-step") }).strict(),
  z.object({ action: z.literal("send-password-reset") }).strict(),
  z.object({ action: z.literal("change-email"), email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")) }).strict(),
]);

/** System administrator actions on a team sign-in (#386). Audited; each signs the person out. */
async function postHandler(request: Request, context: { params: Promise<{ userId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { userId } = await context.params;
    const input = actionSchema.parse(await request.json());
    let message: string;
    if (input.action === "reset-two-step") {
      await resetStaffTwoStep(userId, actor.id);
      message = "Two-step sign-in reset and passkeys removed. They'll set it up again at their next sign-in.";
    } else if (input.action === "send-password-reset") {
      const { queued } = await sendStaffPasswordReset(userId, actor.id);
      message = queued ? "Password reset link sent." : "That account can't receive a reset link (its sign-in is switched off).";
    } else {
      await changeStaffEmail(userId, input.email, actor.id);
      message = "Email changed.";
    }
    return Response.json({ message, directory: await getTeamDirectory() });
  } catch (error) {
    return userAdminApiError(error, "Updating a team account");
  }
}

export const POST = withRequestContext(postHandler);
