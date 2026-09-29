import { ZodError } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { logError } from "@/lib/logger";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { MemberHonorError } from "@/modules/honors/member-honor-repository";

const memberHonorErrorStatus = {
  MEMBER_NOT_FOUND: 404,
  HONOR_NOT_FOUND: 404,
  ENTRY_NOT_FOUND: 404,
  VOID_NOT_ALLOWED: 403,
  ENTRY_ALREADY_VOIDED: 409,
  ENTRY_INVALID: 400,
} as const;

export function memberHonorApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_HONOR_ENTRY_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof RosterAccessError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof MemberHonorError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: memberHonorErrorStatus[error.code] },
    );
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "HONOR_ENTRY_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
