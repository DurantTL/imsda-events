import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError, requireAuthenticatedUser } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireEventCreationPermission } from "@/modules/events/authorization";
import {
  createEvent,
  EventOperationError,
  listEventsForUser,
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
  console.error("Event request failed", error);
  return Response.json({
    error: "EVENT_REQUEST_FAILED",
    message: "The event could not be saved.",
  }, { status: 500 });
}

export async function GET() {
  try {
    const user = requireAuthenticatedUser(await getCurrentSession());
    const events = await listEventsForUser(user.id, user.globalRole === "SYSTEM_ADMIN");
    return Response.json({ events });
  } catch (error) { return eventApiError(error); }
}

export async function POST(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const user = requireEventCreationPermission(await getCurrentSession());
    const input = eventSettingsInputSchema.parse(await request.json());
    const event = await createEvent({ ...input, isPublished: false }, user.id);
    return Response.json({ event }, { status: 201 });
  } catch (error) { return eventApiError(error); }
}
