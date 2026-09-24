import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubMeetingNoteApiError } from "@/modules/club-meeting-notes/api-errors";
import { deleteClubMeetingNote, updateClubMeetingNote } from "@/modules/club-meeting-notes/repository";
import { meetingNoteInputSchema } from "@/modules/club-meeting-notes/schemas";
import { requireClubCapability } from "@/modules/club-rosters/access";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string; noteId: string }> };

/** A director, deputy, or reporter edits their own club's meeting note (#426). */
async function putHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, noteId } = await context.params;
    const access = await requireClubCapability(organizationId, "submitReports");
    const input = meetingNoteInputSchema.parse(await request.json());
    const note = await updateClubMeetingNote(organizationId, noteId, input, access.accountId);
    return Response.json({ note });
  } catch (error) {
    return clubMeetingNoteApiError(error, "Saving the meeting note");
  }
}

async function deleteHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, noteId } = await context.params;
    const access = await requireClubCapability(organizationId, "submitReports");
    await deleteClubMeetingNote(organizationId, noteId, access.accountId);
    return Response.json({ deleted: true });
  } catch (error) {
    return clubMeetingNoteApiError(error, "Deleting the meeting note");
  }
}

export const PUT = withRequestContext(putHandler);
export const DELETE = withRequestContext(deleteHandler);
