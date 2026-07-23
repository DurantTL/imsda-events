import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import {
  cancelRegistration,
  moveRegistrationToWaitlist,
  promoteRegistrationFromWaitlist,
  reactivateRegistration,
  RegistrationLifecycleError,
} from "@/modules/registrations/lifecycle-repository";
import { registrationLifecycleReasonSchema } from "@/modules/registrations/schemas";

const lifecycleActionSchema = z.enum(["cancel", "reactivate", "waitlist", "promote"]);
const noStoreHeaders = { "Cache-Control": "no-store" };

async function processMessagesAfterCommit(messageIds: string[]) {
  if (messageIds.length === 0) return;
  try {
    await processQueuedMessageIdsAfterCommit(messageIds);
  } catch (error) {
    console.error(
      "Lifecycle message processing failed after the registration commit",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return Response.json(
      {
        error: "INVALID_LIFECYCLE_REQUEST",
        message: "Use a supported lifecycle action and an optional reason of 500 characters or fewer.",
        ...(error instanceof z.ZodError ? { issues: error.issues } : {}),
      },
      { status: 400, headers: noStoreHeaders },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status, headers: noStoreHeaders },
    );
  }
  if (error instanceof RegistrationLifecycleError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      {
        status: error.code === "REGISTRATION_NOT_FOUND" ? 404 : 409,
        headers: noStoreHeaders,
      },
    );
  }
  console.error("Registration lifecycle action failed", error);
  return Response.json(
    { error: "REGISTRATION_LIFECYCLE_FAILED" },
    { status: 500, headers: noStoreHeaders },
  );
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{ eventId: string; registrationId: string; action: string }>;
  },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) {
    originError.headers.set("Cache-Control", "no-store");
    return originError;
  }

  try {
    const { eventId, registrationId, action: actionParam } = await context.params;
    const action = lifecycleActionSchema.safeParse(actionParam);
    if (!action.success) {
      return Response.json(
        { error: "LIFECYCLE_ACTION_NOT_FOUND" },
        { status: 404, headers: noStoreHeaders },
      );
    }
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_REGISTRATION",
      findActiveMembership,
    );
    const body = await request.text();
    const { reason } = registrationLifecycleReasonSchema.parse(
      body.trim() ? JSON.parse(body) : {},
    );

    if (action.data === "cancel") {
      const result = await cancelRegistration(
        eventId,
        registrationId,
        access.user.id,
        reason,
      );
      await processMessagesAfterCommit(result.pendingMessageIds);
      return Response.json({
        registration: result.registration,
        autoPromotedRegistration: result.autoPromotedRegistration,
      }, { status: 200, headers: noStoreHeaders });
    }
    if (action.data === "reactivate") {
      const registration = await reactivateRegistration(
        eventId,
        registrationId,
        access.user.id,
        reason,
      );
      return Response.json({ registration }, { status: 200, headers: noStoreHeaders });
    }
    const result = action.data === "waitlist"
      ? await moveRegistrationToWaitlist(eventId, registrationId, access.user.id, reason)
      : await promoteRegistrationFromWaitlist(eventId, registrationId, access.user.id, reason);
    await processMessagesAfterCommit(result.pendingMessageIds);
    const registration = result.registration;
    return Response.json({ registration }, { status: 200, headers: noStoreHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
