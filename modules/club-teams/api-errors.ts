import { z } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { ClubTeamError, clubTeamErrorStatus } from "@/modules/club-teams/errors";

const noStore = { "Cache-Control": "no-store" };

/** One answer for every club team route (#809): access, bad input, a refusal of ours, or an unexpected failure. */
export function clubTeamApiError(error: unknown, action: string) {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status, headers: noStore });
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_REQUEST", message: error.issues[0]?.message ?? "The request is invalid.", issues: error.issues },
      { status: 400, headers: noStore },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "INVALID_JSON", message: "The request is not valid JSON." }, { status: 400, headers: noStore });
  }
  if (error instanceof ClubTeamError) {
    return Response.json({ error: error.code, message: error.message, problems: error.problems }, { status: clubTeamErrorStatus(error.code), headers: noStore });
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "CLUB_TEAM_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500, headers: noStore },
  );
}
