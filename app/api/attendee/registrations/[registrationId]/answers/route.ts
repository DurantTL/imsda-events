import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import {
  AttendeeAnswerUpdateError,
} from "@/modules/attendee-accounts/registration-answer-policy";
import {
  updateTieredAttendeeAnswers,
} from "@/modules/attendee-accounts/registrations-repository";
import { withRequestContext } from "@/lib/request-context";

const attendeeSchema = z.strictObject({
  attendeeId: z.string().trim().min(1).max(100),
  responses: z.record(z.string().trim().min(1).max(80), z.unknown()),
});

const inputSchema = z.strictObject({
  clientRequestId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
  attendees: z.array(attendeeSchema).min(1).max(50),
});

type Context = { params: Promise<{ registrationId: string }> };

async function putHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const { account, via } = await getCurrentAttendee();
  if (!account || via !== "attendee") {
    return Response.json(
      { error: "SIGN_IN_REQUIRED", message: "Sign in to update attendee choices." },
      { status: 401 },
    );
  }
  try {
    const input = inputSchema.parse(await request.json());
    const { registrationId } = await context.params;
    const result = await updateTieredAttendeeAnswers({
      accountId: account.id,
      verifiedEmail: account.verifiedEmail,
      registrationId,
      ...input,
    });
    if (!result) {
      return Response.json(
        { error: "REGISTRATION_UNAVAILABLE", message: "This registration is unavailable." },
        { status: 404 },
      );
    }
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          error: "INVALID_REQUEST",
          message: error.issues[0]?.message ?? "Review the choices and try again.",
        },
        { status: 400 },
      );
    }
    if (error instanceof AttendeeAnswerUpdateError) {
      const status = error.code === "EDIT_POLICY_REQUIRES_VERIFICATION"
        ? 403
        : error.code === "SEMINAR_PREFERENCES_LOCKED"
          || error.code === "FINAL_ASSIGNMENT_LOCKED"
          || error.code === "IDEMPOTENCY_KEY_REUSED"
          ? 409
          : 400;
      return Response.json(
        { error: error.code, message: error.message },
        { status },
      );
    }
    throw error;
  }
}

export const PUT = withRequestContext(putHandler);
