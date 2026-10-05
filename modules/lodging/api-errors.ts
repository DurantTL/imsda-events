import { z } from "zod";
import { logError } from "@/lib/logger";
import { isLockTimeoutError, isSerializationFailure } from "@/lib/prisma-errors";
import { AccessDeniedError } from "@/modules/access/authorization";
import { LodgingError, lodgingErrorStatus } from "@/modules/lodging/errors";

const noStore = { "Cache-Control": "no-store" };

export function lodgingApiError(error: unknown, action: string) {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status, headers: noStore });
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_LODGING_INPUT", message: error.issues[0]?.message ?? "Review the details.", issues: error.issues },
      { status: 400, headers: noStore },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "INVALID_JSON", message: "The request is not valid JSON." }, { status: 400, headers: noStore });
  }
  if (error instanceof LodgingError) {
    return Response.json({ error: error.code, message: error.message }, { status: lodgingErrorStatus(error.code), headers: noStore });
  }
  if (isLockTimeoutError(error)) {
    return Response.json({ error: "LODGING_BUSY", message: "That is being updated by someone else right now. Nothing was saved. Try again in a moment." }, { status: 503, headers: noStore });
  }
  if (isSerializationFailure(error)) {
    return Response.json({ error: "LODGING_CONFLICT", message: "Another change landed at the same time. Refresh and try again." }, { status: 409, headers: noStore });
  }
  logError(`${action} failed`, error);
  return Response.json({ error: "LODGING_REQUEST_FAILED", message: `${action} could not be completed.` }, { status: 500, headers: noStore });
}
