import { ZodError } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { logError } from "@/lib/logger";

export function backgroundCheckApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_BACKGROUND_CHECK_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "BACKGROUND_CHECK_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
