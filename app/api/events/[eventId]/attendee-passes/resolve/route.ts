import { z } from "zod";
import {
  AccessDeniedError,
  requirePermission,
} from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  AttendeePassResolutionError,
  resolveAttendeePassForEvent,
} from "@/modules/checkin/attendee-pass-repository";
import { findActiveMembership } from "@/modules/events/repository";

const maximumBodyBytes = 4 * 1_024;
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

const lookupSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pass"),
    value: z.string().trim().min(1).max(768),
  }),
  z.strictObject({
    kind: z.literal("confirmation"),
    value: z.string().trim().min(3).max(80),
  }),
]);

type RouteContext = {
  params: Promise<{ eventId: string }>;
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

function errorResponse(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  if (error instanceof AttendeePassResolutionError) {
    const status = error.code === "PASS_EXPIRED"
      ? 410
      : error.code === "REGISTRATION_NOT_ELIGIBLE"
        ? 409
        : 404;
    return json(
      { error: error.code, message: error.message },
      { status },
    );
  }
  if (error instanceof z.ZodError) {
    return json({
      error: "INVALID_PASS_LOOKUP",
      message: error.issues[0]?.message
        ?? "Enter a valid attendee pass or confirmation code.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof SyntaxError) {
    return json({
      error: "INVALID_JSON",
      message: "The attendee pass lookup is not valid JSON.",
    }, { status: 400 });
  }
  console.error(
    "Attendee pass lookup failed.",
    error instanceof Error ? error.name : "UnknownError",
  );
  return json({
    error: "ATTENDEE_PASS_LOOKUP_FAILED",
    message: "The attendee pass could not be checked. Try again.",
  }, { status: 500 });
}

export async function POST(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return applyPrivateHeaders(originError);

  try {
    const { eventId } = await context.params;
    await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_CHECK_IN",
      findActiveMembership,
    );

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The attendee pass lookup is too large.",
      }, { status: 413 });
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > maximumBodyBytes) {
      return json({
        error: "REQUEST_TOO_LARGE",
        message: "The attendee pass lookup is too large.",
      }, { status: 413 });
    }

    const lookup = lookupSchema.parse(JSON.parse(rawBody));
    const resolution = await resolveAttendeePassForEvent(eventId, lookup);
    return json({ resolution });
  } catch (error) {
    return errorResponse(error);
  }
}

