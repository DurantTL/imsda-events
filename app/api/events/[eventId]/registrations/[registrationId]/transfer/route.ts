import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  ensureEventMessagingDefaults,
  processQueuedMessageIdsAfterCommit,
} from "@/modules/communications/messaging-repository";
import { findActiveMembership } from "@/modules/events/repository";
import { createStableRegistrationAccessToken } from "@/modules/public-access/repository";
import {
  RegistrationOperationError,
  transferRegistration,
} from "@/modules/registrations/operations-repository";
import { registrationTransferInputSchema } from "@/modules/registrations/schemas";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const noStoreHeaders = { "Cache-Control": "no-store" };

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return Response.json(
      {
        error: "INVALID_TRANSFER_REQUEST",
        message: "Review the new contact details and submit the two-step transfer again.",
        ...(error instanceof z.ZodError ? { issues: error.issues } : {}),
      },
      { status: 400, headers: noStoreHeaders }
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status, headers: noStoreHeaders }
    );
  }
  if (error instanceof RegistrationOperationError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      {
        status: error.code === "REGISTRATION_NOT_FOUND" ? 404 : 409,
        headers: noStoreHeaders,
      }
    );
  }
  logError("Registration transfer failed", error);
  return Response.json(
    { error: "REGISTRATION_TRANSFER_FAILED" },
    { status: 500, headers: noStoreHeaders }
  );
}

async function postHandler(
  request: Request,
  context: {
    params: Promise<{ eventId: string; registrationId: string }>;
  },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) {
    originError.headers.set("Cache-Control", "no-store");
    return originError;
  }
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return Response.json(
      {
        error: "JSON_CONTENT_TYPE_REQUIRED",
        message: "Send this request as application/json.",
      },
      { status: 415, headers: noStoreHeaders }
    );
  }

  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_REGISTRATION",
      findActiveMembership
    );
    const input = registrationTransferInputSchema.parse(await request.json());
    await ensureEventMessagingDefaults(eventId);
    const result = await transferRegistration(
      eventId,
      registrationId,
      input,
      {
        id: access.user.id,
        displayName: access.user.displayName,
      }
    );
    const accessDeliveryMessageId = result.response.operation.noticeMessageIds[0];
    if (accessDeliveryMessageId) {
      try {
        await createStableRegistrationAccessToken({
          registrationId,
          deliveryKey: `message:${accessDeliveryMessageId}`,
        });
      } catch (error) {
        logError("Post-commit transfer access issuance failed", error);
      }
    }
    try {
      await processQueuedMessageIdsAfterCommit(result.pendingMessageIds);
    } catch (error) {
      logError("Transfer notice processing failed after commit", error);
    }
    return Response.json(result.response, {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = withRequestContext(postHandler);
