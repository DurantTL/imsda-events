import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import {
  attachSquarePaymentToRegistration,
  listUnmatchedSquarePayments,
  SquareMatchOperationError,
} from "@/modules/payments/square-match-repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const noStoreHeaders = { "Cache-Control": "no-store" };

const attachSchema = z.strictObject({
  providerPaymentId: z.string().trim().min(1).max(255),
  registrationId: z.string().trim().min(1).max(64),
  note: z.string().trim().max(500).optional(),
  acknowledgeDuplicate: z.boolean().optional(),
});

const statusForCode: Record<SquareMatchOperationError["code"], number> = {
  SQUARE_NOT_CONFIGURED: 503,
  SQUARE_UNREACHABLE: 503,
  PROVIDER_PAYMENT_NOT_FOUND: 404,
  PROVIDER_PAYMENT_NOT_COMPLETED: 409,
  PROVIDER_PAYMENT_WRONG_LOCATION: 409,
  PAYMENT_ALREADY_RECORDED: 409,
  PAYMENT_LIKELY_DUPLICATE: 409,
  REGISTRATION_NOT_FOUND: 404,
  REGISTRATION_NOT_PAYABLE: 409,
};

function failure(error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_REQUEST", issues: error.issues },
      { status: 400, headers: noStoreHeaders },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status, headers: noStoreHeaders },
    );
  }
  if (error instanceof SquareMatchOperationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: statusForCode[error.code], headers: noStoreHeaders },
    );
  }
  logError(fallback, error);
  return Response.json(
    { error: "SQUARE_MATCH_FAILED" },
    { status: 500, headers: noStoreHeaders },
  );
}

async function getHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_FINANCE",
      findActiveMembership,
    );
    const days = Number(new URL(request.url).searchParams.get("days") ?? 90);
    const result = await listUnmatchedSquarePayments({
      days: Number.isFinite(days) ? days : 90,
    });
    return Response.json(result, { headers: noStoreHeaders });
  } catch (error) {
    return failure(error, "Unable to list unmatched Square payments");
  }
}

async function postHandler(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(
      await getCurrentSession(),
      eventId,
      "MANAGE_FINANCE",
      findActiveMembership,
    );
    const input = attachSchema.parse(await request.json());
    const result = await attachSquarePaymentToRegistration(
      eventId,
      input.registrationId,
      access.user.id,
      {
        providerPaymentId: input.providerPaymentId,
        note: input.note,
        acknowledgeDuplicate: input.acknowledgeDuplicate,
      },
    );
    return Response.json(result, { status: 201, headers: noStoreHeaders });
  } catch (error) {
    return failure(error, "Unable to attach a Square payment");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
