import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { MemberTransferError } from "@/modules/club-transfers/repository";

/**
 * One error shape for every club member transfer route (#489). A typed
 * `MemberTransferError` carries its own status (404, 409 and so on); any
 * unique-index collision that slipped past the repository's own checks is a
 * 409 conflict, never a 500.
 */
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
      { error: error.code, message: error.message, ...(error.blocker ? { blocker: error.blocker } : {}) },
      { status: error.status },
    );
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return Response.json(
      { error: "TRANSFER_CONFLICT", message: "This transfer changed at the same time as your request. Refresh and try again." },
      { status: 409 },
    );
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "TRANSFER_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
