import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { EventDeletionError, deleteEvent } from "@/modules/events/deletion-repository";
import { findActiveMembership } from "@/modules/events/repository";
import {
  EventOperationError,
  getEventSettings,
  updateEventSettings,
} from "@/modules/events/repository";
import { eventSettingsInputSchema } from "@/modules/events/schemas";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

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
  if (error instanceof EventDeletionError) {
    const status = error.code === "EVENT_NOT_FOUND" ? 404
      : error.code === "EVENT_DELETE_FORBIDDEN" ? 403
      : error.code === "EVENT_NAME_MISMATCH" ? 400
      : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof EventOperationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "EVENT_NOT_FOUND" ? 404 : 409 }
    );
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return Response.json({
      error: "EVENT_SLUG_TAKEN",
      message: "That event web address is already in use. Choose another short address.",
    }, { status: 409 });
  }
  logError("Event settings request failed", error);
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
    findActiveMembership
  );
}

async function getHandler(
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

async function patchHandler(
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

const deleteEventInputSchema = z.object({ confirmName: z.string().max(300) });

async function deleteHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await authorize(eventId);
    const input = deleteEventInputSchema.parse(await request.json().catch(() => ({})));
    // Whether this actor may delete this event (system admin: always; Event
    // Admin: drafts only) is decided inside the deleting transaction.
    const result = await deleteEvent({
      eventId,
      actor: { userId: access.user.id, globalRole: access.user.globalRole },
      confirmName: input.confirmName,
    });
    return Response.json({ deleted: true, name: result.name, counts: result.counts });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "EVENT_NAME_MISMATCH", message: "Type the event's exact name to confirm the deletion." }, { status: 400 });
    }
    return eventApiError(error);
  }
}

export const GET = withRequestContext(getHandler);
export const DELETE = withRequestContext(deleteHandler);
export const PATCH = withRequestContext(patchHandler);
