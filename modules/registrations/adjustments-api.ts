import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { AdjustmentError } from "@/modules/registrations/adjustments";
import { logError } from "@/lib/logger";

export function adjustmentApiError(error: unknown, action: string) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: "INVALID_ADJUSTMENT", message: error.issues[0]?.message ?? "Review the adjustment.", issues: error.issues }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof AdjustmentError) {
    const status = error.code.endsWith("_NOT_FOUND") ? 404 : error.code === "PROMO_INVALID" ? 400 : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  logError(`${action} failed`, error);
  return Response.json({ error: "ADJUSTMENT_FAILED", message: "The adjustment could not be saved." }, { status: 500 });
}
