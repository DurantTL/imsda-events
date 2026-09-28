import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { MemberHonorError } from "@/modules/honors/member-honor-repository";

export function memberHonorApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_HONOR_ENTRY_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof RosterAccessError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof MemberHonorError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "MEMBER_NOT_FOUND" || error.code === "HONOR_NOT_FOUND" ? 404 : 400 },
    );
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "HONOR_ENTRY_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
