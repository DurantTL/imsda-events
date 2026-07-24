import { z } from "zod";
import { describeAccountToken, resetPassword } from "@/modules/access/auth-service";
import { validateChosenPassword } from "@/modules/access/passwords";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const resetSchema = z.object({
  token: z.string().min(32).max(256),
  password: z.string().min(1).max(128),
  confirmation: z.string().min(1).max(128),
}).superRefine((value, context) => {
  if (value.password !== value.confirmation) {
    context.addIssue({ code: "custom", path: ["confirmation"], message: "Passwords do not match." });
  }
});

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  try {
    const input = resetSchema.parse(await request.json());

    // The owner's name and address are part of the policy — a password that
    // contains them is guessable by anyone who has seen a staff list — so the
    // token is described before the password is judged. An invalid token
    // reveals nothing here; it is rejected by resetPassword below with the
    // same message it always used.
    const described = await describeAccountToken(input.token);
    const passwordError = await validateChosenPassword(input.password, {
      email: described?.owner.email,
      displayName: described?.owner.displayName,
    });
    if (passwordError) {
      return Response.json(
        { error: "INVALID_PASSWORD", message: passwordError },
        { status: 400 },
      );
    }

    const changed = await resetPassword(input.token, input.password);
    if (!changed) {
      return Response.json({ error: "RESET_LINK_INVALID", message: "This reset link is invalid or has expired. Request a new one." }, { status: 400 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_PASSWORD", message: error.issues[0]?.message ?? "Choose a valid password." }, { status: 400 });
    }
    logError("Password reset failed", error);
    return Response.json({ error: "RESET_FAILED", message: "The password could not be reset." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
