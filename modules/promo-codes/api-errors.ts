import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { PromoCodeOperationError } from "@/modules/promo-codes/repository";

export function promoCodeApiError(error: unknown, operation: string) {
  if (error instanceof AccessDeniedError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      {
        error: "INVALID_PROMO_CODE",
        message: error.issues[0]?.message ?? "Review the promo-code details.",
        issues: error.issues,
      },
      { status: 400 },
    );
  }
  if (error instanceof PromoCodeOperationError) {
    const status = error.code === "EVENT_NOT_FOUND"
      || error.code === "PROMO_CODE_NOT_FOUND"
      ? 404
      : 409;
    return Response.json(
      { error: error.code, message: error.message },
      { status },
    );
  }
  console.error(
    `${operation} failed`,
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    {
      error: "PROMO_CODE_OPERATION_FAILED",
      message: `${operation} could not be completed.`,
    },
    { status: 500 },
  );
}

