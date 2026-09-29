import { Prisma } from "@prisma/client";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { isLockTimeoutError } from "@/lib/prisma-errors";
import { AccessDeniedError } from "@/modules/access/authorization";
import { EventCloneReviewError } from "@/modules/event-clones/domain";
import { EventCloneOperationError } from "@/modules/event-clones/repository";

const operationStatus: Record<EventCloneOperationError["code"], number> = {
  SOURCE_NOT_FOUND: 404,
  SOURCE_CHANGED: 409,
  SOURCE_BUSY: 409,
  EVENT_SLUG_TAKEN: 409,
  REQUEST_KEY_REUSED: 409,
};

/**
 * The one error mapping the `/api/event-clones/**` routes share (#157):
 * validation and incomplete review are 400, permission errors keep their
 * status, a missing source is 404, a changed source, taken address, or reused
 * key is 409, and anything unexpected is logged (redacted, via `logError`) and
 * returned as a generic 500.
 */
export function eventCloneApiError(
  error: unknown,
  options: { failureMessage: string; logMessage: string; invalidInputCode: string; uniqueViolationIsSlug?: boolean },
) {
  if (error instanceof z.ZodError) {
    return Response.json({
      error: options.invalidInputCode,
      message: error.issues[0]?.message ?? "Review the details and try again.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: options.invalidInputCode, message: "The request body is not valid JSON." }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof EventCloneReviewError) {
    return Response.json({ error: "CLONE_REVIEW_INCOMPLETE", message: error.message, issues: error.issues }, { status: 400 });
  }
  if (error instanceof EventCloneOperationError) {
    return Response.json({ error: error.code, message: error.message }, { status: operationStatus[error.code] });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && options.uniqueViolationIsSlug) {
    return Response.json({
      error: "EVENT_SLUG_TAKEN",
      message: "That event web address is already in use. Choose another short address.",
    }, { status: 409 });
  }
  // A source lock wait past `lock_timeout` (SQLSTATE 55P03), a wait past the
  // transaction timeout (P2028), or a serialization failure (P2034) is a busy
  // source, not a fault: nothing was written.
  // A wait past the transaction timeout means the copy itself ran long: say so, so nobody waits on a
  // spinner or blames the source (#617). Nothing was written either way.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028") {
    // Prisma words a queue wait ("Unable to start a transaction in the given time") differently from a
    // transaction that ran past its limit ("Transaction already closed ... timeout"). Anything else is neutral.
    const message = /unable to start/i.test(error.message)
      ? "The system is busy, so the copy could not start and nothing was created. Try again in a moment."
      : /transaction already closed|timeout/i.test(error.message)
        ? "The copy took too long and was cancelled, so nothing was created. Try again in a moment."
        : "The copy couldn't finish, so nothing was created. Try again.";
    return Response.json({ error: "SOURCE_BUSY", message }, { status: 409 });
  }
  if (isLockTimeoutError(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")) {
    return Response.json({ error: "SOURCE_BUSY", message: "The source event is busy right now. Try again in a moment." }, { status: 409 });
  }
  logError(options.logMessage, error);
  return Response.json({ error: "EVENT_CLONE_REQUEST_FAILED", message: options.failureMessage }, { status: 500 });
}
