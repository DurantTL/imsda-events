import { Prisma } from "@prisma/client";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { isLockTimeoutError } from "@/lib/prisma-errors";
import { AccessDeniedError } from "@/modules/access/authorization";
import { EventTemplateReferenceError } from "@/modules/event-templates/domain";
import { EventTemplateOperationError } from "@/modules/event-templates/repository";

const operationStatus: Record<EventTemplateOperationError["code"], number> = {
  TEMPLATE_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  TEMPLATE_ARCHIVED: 409,
  NO_DRAFT: 409,
  NO_PUBLISHED_VERSION: 409,
  EDIT_CONFLICT: 409,
  EVENT_SLUG_TAKEN: 409,
  REQUEST_KEY_REUSED: 409,
};

/**
 * The one error mapping every `/api/event-templates/**` route uses (#152):
 * validation is 400, permission errors keep their status, a missing template
 * is 404, lifecycle and concurrency conflicts are 409, and anything
 * unexpected is logged (redacted, via `logError`) and returned as a generic
 * 500. `referenceStatus` lets publish report an invalid draft as 400 while
 * apply reports a stale published version as 409; only apply creates an event,
 * so only apply reads a leftover unique violation as a taken event slug.
 */
export function eventTemplateApiError(
  error: unknown,
  options: { failureMessage: string; logMessage: string; referenceStatus?: number; invalidInputCode?: string; uniqueViolationIsSlug?: boolean },
) {
  if (error instanceof z.ZodError) {
    return Response.json({
      error: options.invalidInputCode ?? "INVALID_EVENT_TEMPLATE",
      message: error.issues[0]?.message ?? "Review the details and try again.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: options.invalidInputCode ?? "INVALID_EVENT_TEMPLATE", message: "The request body is not valid JSON." }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof EventTemplateReferenceError) {
    return Response.json({ error: "TEMPLATE_REFERENCES_INVALID", message: error.message, issues: error.issues }, { status: options.referenceStatus ?? 400 });
  }
  if (error instanceof EventTemplateOperationError) {
    return Response.json({ error: error.code, message: error.message }, { status: operationStatus[error.code] });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    if (!options.uniqueViolationIsSlug) {
      return Response.json({ error: "EDIT_CONFLICT", message: "This template changed in another session. Reload it and try again." }, { status: 409 });
    }
    return Response.json({
      error: "EVENT_SLUG_TAKEN",
      message: "That event web address is already in use. Choose another short address.",
    }, { status: 409 });
  }
  // A template lock wait past `lock_timeout` (SQLSTATE 55P03), a wait that
  // outlasts the transaction timeout (P2028), or a serialization failure
  // (P2034) is a busy template, not a server fault: nothing was written, so
  // the caller can simply try again.
  if (isLockTimeoutError(error) || (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2028" || error.code === "P2034"))) {
    return Response.json({ error: "TEMPLATE_BUSY", message: "This template is busy right now. Try again in a moment." }, { status: 409 });
  }
  logError(options.logMessage, error);
  return Response.json({ error: "EVENT_TEMPLATE_REQUEST_FAILED", message: options.failureMessage }, { status: 500 });
}
