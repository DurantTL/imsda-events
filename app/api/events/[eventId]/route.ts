import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import {
  EventOperationError,
  getEventSettings,
  updateEventSettings,
} from "@/modules/events/repository";
import { eventSettingsInputSchema } from "@/modules/events/schemas";

function eventApiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({
      error: "INVALID_EVENT",
      message: error.issues[0]?.message ?? "Review the event details and try again.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof EventOperationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "EVENT_NOT_FOUND" ? 404 : 409 },
    );
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return Response.json({
      error: "EVENT_SLUG_TAKEN",
      message: "That event web address is already in use. Choose another short address.",
    }, { status: 409 });
  }
  console.error("Event settings request failed", error);
  return Response.json({
    error: "EVENT_REQUEST_FAILED",
    message: "The event settings could not be saved.",
  }, { status: 500 });
}

async function authorize(eventId: string) {
  return requirePermission(
    await getCurrentSession(),
    eventId,
    "CONFIGURE_EVENT",
    findActiveMembership,
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await authorize(eventId);
    const event = await getEventSettings(eventId);
    return event
      ? Response.json({ event })
      : Response.json({ error: "EVENT_NOT_FOUND", message: "That event no longer exists." }, { status: 404 });
  } catch (error) { return eventApiError(error); }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await authorize(eventId);
    const input = eventSettingsInputSchema.parse(await request.json());
    const event = await updateEventSettings(eventId, input, access.user.id);
    return Response.json({ event });
  } catch (error) { return eventApiError(error); }
}
