import "server-only";

import { z } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { NewClubApplicationError, type NewClubApplicationErrorCode } from "@/modules/club-applications/repository";

const statusByCode: Record<NewClubApplicationErrorCode, number> = {
  TOO_QUICK: 400,
  INVALID_CHURCH: 400,
  CHURCH_REQUIRED: 409,
  INVITE_UNAVAILABLE: 410,
  ATTACHMENT_TYPE: 415,
  ATTACHMENT_TOO_LARGE: 413,
  ATTACHMENT_CONTENT: 415,
  APPLICATION_NOT_FOUND: 404,
  ALREADY_DECIDED: 409,
  INVALID_REASON: 400,
  EMAIL_NOT_CONFIGURED: 409,
  INVITE_NOT_FOUND: 404,
};

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/** One place that turns a new club application failure into a response. Never echoes a stack or a database message. */
export function newClubApplicationApiError(error: unknown, action: string) {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_REQUEST", message: error.issues[0]?.message ?? "Check the form and try again.", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
      { status: 400, headers: noStore },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "INVALID_JSON", message: "The request was not valid." }, { status: 400, headers: noStore });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status, headers: noStore });
  }
  if (error instanceof NewClubApplicationError) {
    return Response.json({ error: error.code, message: error.message }, { status: statusByCode[error.code], headers: noStore });
  }
  logError(`${action} failed.`, error);
  return Response.json({ error: "NEW_CLUB_APPLICATION_FAILED", message: "That could not be completed. Please try again." }, { status: 500, headers: noStore });
}
