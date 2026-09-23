import { ZodError } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { HonorConfigurationError } from "@/modules/honors/repository";
import { logError } from "@/lib/logger";

export function honorApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_HONOR_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof HonorConfigurationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code.endsWith("_NOT_FOUND") ? 404 : 409 },
    );
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "HONOR_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
