import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { checkInRequestSchema } from "@/modules/checkin/domain";
import {
  CheckInOperationError,
  checkInAttendee,
  undoCheckIn,
} from "@/modules/checkin/repository";
import { findActiveMembership } from "@/modules/events/repository";

const maximumBodyBytes = 1_024;
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      ...privateHeaders,
      ...init?.headers,
    },
  });
}

function applyPrivateHeaders(response: Response) {
  Object.entries(privateHeaders).forEach(([name, value]) => {
    response.headers.set(name, value);
  });
  return response;
}

function apiError(error: unknown) {
  if (error instanceof AccessDeniedError) return json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof CheckInOperationError) {
    return json(
      { error: error.code, message: error.message },
      { status: error.code === "ATTENDEE_NOT_FOUND" ? 404 : 409 },
    );
  }
  if (error instanceof z.ZodError) {
    return json({
      error: "INVALID_CHECK_IN_REQUEST",
      message: "A valid saved check-in key is required.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof SyntaxError) {
    return json({
      error: "INVALID_JSON",
      message: "The check-in request is not valid JSON.",
    }, { status: 400 });
  }
  console.error("Check-in request failed", error);
  return json({
    error: "CHECK_IN_REQUEST_FAILED",
    message: "The server could not confirm this check-in. Retry with the same saved action.",
  }, { status: 500 });
}

async function authorize(eventId: string) {
  return requirePermission(await getCurrentSession(), eventId, "MANAGE_CHECK_IN", findActiveMembership);
}

export async function POST(request: Request, context: { params: Promise<{ eventId: string; attendeeId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return applyPrivateHeaders(originError);
  try {
    const { eventId, attendeeId } = await context.params;
    const access = await authorize(eventId);
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The check-in request is too large.",
      }, { status: 413 });
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The check-in request is too large.",
      }, { status: 413 });
    }
    const input = checkInRequestSchema.parse(JSON.parse(rawBody));
    const operation = await checkInAttendee(
      eventId,
      attendeeId,
      access.user.id,
      input.idempotencyKey,
    );
    return json(operation);
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ eventId: string; attendeeId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return applyPrivateHeaders(originError);
  try {
    const { eventId, attendeeId } = await context.params;
    const access = await authorize(eventId);
    const checkIn = await undoCheckIn(eventId, attendeeId, access.user.id);
    return checkIn
      ? json({ checkIn })
      : json({
          error: "ACTIVE_CHECK_IN_NOT_FOUND",
          message: "This attendee does not have an active check-in to undo.",
        }, { status: 404 });
  } catch (error) {
    return apiError(error);
  }
}
