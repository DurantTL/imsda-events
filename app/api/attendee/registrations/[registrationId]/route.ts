import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { updateAttendeeRegistrationContact } from "@/modules/attendee-accounts/registrations-repository";
import { publicContactUpdateSchema } from "@/modules/public-access/domain";
import { withRequestContext } from "@/lib/request-context";

const inputSchema = z.strictObject({
  code: z.string().transform((value) => value.replace(/\s+/g, "")).pipe(z.string().length(6)),
  contact: publicContactUpdateSchema,
});
type Context = { params: Promise<{ registrationId: string }> };

async function patchHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const { account, via, sessionId } = await getCurrentAttendee();
  if (!account || via !== "attendee" || !sessionId) {
    return Response.json(
      { error: "SIGN_IN_REQUIRED", message: "Sign in to edit a registration." },
      { status: 401 },
    );
  }
  try {
    const input = inputSchema.parse(await request.json());
    const { registrationId } = await context.params;
    const result = await updateAttendeeRegistrationContact({
      accountId: account.id,
      verifiedEmail: account.verifiedEmail,
      sessionId,
      registrationId,
      code: input.code,
      contact: input.contact,
    });
    if (!result) {
      return Response.json(
        { error: "REGISTRATION_UNAVAILABLE", message: "This registration is unavailable." },
        { status: 404 },
      );
    }
    if (!result.codeAccepted) {
      return Response.json(
        { error: "EDIT_CODE_INVALID", message: "That edit code is invalid or expired." },
        { status: 400 },
      );
    }
    return Response.json({ contact: result.contact });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "INVALID_REQUEST", message: error.issues[0]?.message ?? "Review the details and try again." },
        { status: 400 },
      );
    }
    throw error;
  }
}

export const PATCH = withRequestContext(patchHandler);
