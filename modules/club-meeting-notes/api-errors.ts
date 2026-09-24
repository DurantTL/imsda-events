import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { ClubMeetingNoteError } from "@/modules/club-meeting-notes/repository";
import { RosterAccessError } from "@/modules/club-rosters/access";

export function clubMeetingNoteApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json({ error: "INVALID_MEETING_NOTE", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  }
  if (error instanceof RosterAccessError || error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ClubMeetingNoteError) {
    const status = error.code === "CLUB_NOT_FOUND" || error.code === "NOTE_NOT_FOUND" ? 404 : 400;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  logError(`${action} failed`, error);
  return Response.json({ error: "CLUB_MEETING_NOTE_FAILED", message: `${action} could not be completed.` }, { status: 500 });
}
