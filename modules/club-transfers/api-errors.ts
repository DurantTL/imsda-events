import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { MemberTransferError } from "@/modules/club-transfers/repository";

const notFoundCodes = new Set(["TRANSFER_NOT_FOUND", "MEMBER_NOT_FOUND"]);

export function memberTransferApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_TRANSFER_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof RosterAccessError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof MemberTransferError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: notFoundCodes.has(error.code) ? 404 : 400 },
    );
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "TRANSFER_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
