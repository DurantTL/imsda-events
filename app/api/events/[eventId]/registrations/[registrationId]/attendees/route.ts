import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import {
  addRegistrationAttendee,
  RegistrationAttendeeOperationError,
} from "@/modules/registrations/repository";
import { attendeeInputSchema } from "@/modules/registrations/schemas";

export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string; registrationId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_REGISTRATION",
      findActiveMembership,
    );
    const input = attendeeInputSchema.parse(await request.json());
    const registration = await addRegistrationAttendee(eventId, registrationId, input, access.user.id);
    return Response.json({ registration }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_ATTENDEE", issues: error.issues }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof RegistrationAttendeeOperationError) {
      return Response.json(
        { error: error.code, message: error.message, details: error.details },
        { status: error.code === "REGISTRATION_NOT_FOUND" ? 404 : 409 },
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return Response.json({ error: "ATTENDEE_ALREADY_REGISTERED", message: "That person is already attached to this registration." }, { status: 409 });
    }
    console.error("Unable to add registration attendee", error);
    return Response.json({ error: "ATTENDEE_CREATE_FAILED" }, { status: 500 });
  }
}
