import { z } from "zod";
import { resetPassword } from "@/modules/access/auth-service";
import { validatePassword } from "@/modules/access/passwords";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";

const resetSchema = z.object({
  token: z.string().min(32).max(256),
  password: z.string().min(1).max(128),
  confirmation: z.string().min(1).max(128),
}).superRefine((value, context) => {
  const passwordError = validatePassword(value.password);
  if (passwordError) context.addIssue({ code: "custom", path: ["password"], message: passwordError });
  if (value.password !== value.confirmation) context.addIssue({ code: "custom", path: ["confirmation"], message: "Passwords do not match." });
});

export async function POST(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  try {
    const input = resetSchema.parse(await request.json());
    const changed = await resetPassword(input.token, input.password);
    if (!changed) {
      return Response.json({ error: "RESET_LINK_INVALID", message: "This reset link is invalid or has expired. Request a new one." }, { status: 400 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_PASSWORD", message: error.issues[0]?.message ?? "Choose a valid password." }, { status: 400 });
    }
    console.error("Password reset failed", error);
    return Response.json({ error: "RESET_FAILED", message: "The password could not be reset." }, { status: 500 });
  }
}
