import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { ClubSupplyError } from "@/modules/club-supplies/repository";

/** Maps club supply errors to responses (#531). A catalog conflict is 409, never 404. */
export function clubSupplyApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_CLUB_SUPPLY_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof RosterAccessError || error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ClubSupplyError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.code === "ITEM_NOT_FOUND" ? 404 : 409 });
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "CLUB_SUPPLY_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
