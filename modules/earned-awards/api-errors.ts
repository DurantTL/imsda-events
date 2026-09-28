import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { EarnedAwardError } from "@/modules/earned-awards/errors";
import { MasterAwardRulesFileError } from "@/modules/earned-awards/master-award-import";

/** Maps staff-side earned award errors (event links, Master Award rules) to responses (#532). */
export function earnedAwardApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_EARNED_AWARD_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof MasterAwardRulesFileError) {
    return Response.json({ error: "INVALID_MASTER_AWARD_RULES_FILE", message: error.message }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof EarnedAwardError) {
    const notFound = error.code === "EVENT_NOT_FOUND" || error.code === "RULE_NOT_FOUND";
    return Response.json({ error: error.code, message: error.message }, { status: notFound ? 404 : 409 });
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "EARNED_AWARD_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
