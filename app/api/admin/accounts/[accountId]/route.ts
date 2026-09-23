import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { changeAttendeeEmail, resetAttendeeTwoStep, signOutAttendeeEverywhere } from "@/modules/system-admin/user-admin";
import { userAdminApiError } from "@/modules/system-admin/user-admin-api";
import { withRequestContext } from "@/lib/request-context";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset-two-step") }).strict(),
  z.object({ action: z.literal("sign-out") }).strict(),
  z.object({ action: z.literal("change-email"), email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")) }).strict(),
]);

/** System administrator actions on an attendee account (#386). Audited. */
async function postHandler(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { accountId } = await context.params;
    const input = actionSchema.parse(await request.json());
    if (input.action === "reset-two-step") {
      await resetAttendeeTwoStep(accountId, actor.id);
      return Response.json({ message: "Two-step sign-in reset and signed out everywhere. Club roles will set it up again at their next sign-in." });
    }
    if (input.action === "sign-out") {
      await signOutAttendeeEverywhere(accountId, actor.id);
      return Response.json({ message: "Signed out everywhere." });
    }
    await changeAttendeeEmail(accountId, input.email, actor.id);
    return Response.json({ message: "Email changed and signed out everywhere." });
  } catch (error) {
    return userAdminApiError(error, "Updating an account");
  }
}

export const POST = withRequestContext(postHandler);
