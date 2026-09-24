import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubMeetingNoteApiError } from "@/modules/club-meeting-notes/api-errors";
import { createClubMeetingNote, listClubMeetingNotes } from "@/modules/club-meeting-notes/repository";
import { meetingNoteInputSchema } from "@/modules/club-meeting-notes/schemas";
import { requireClubCapability } from "@/modules/club-rosters/access";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** A club's meeting notes, for a director, deputy, or reporter (#426, reuses the report roles gate). */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    await requireClubCapability(organizationId, "submitReports");
    return Response.json({ notes: await listClubMeetingNotes(organizationId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubMeetingNoteApiError(error, "Loading meeting notes");
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireClubCapability(organizationId, "submitReports");
    const input = meetingNoteInputSchema.parse(await request.json());
    const note = await createClubMeetingNote(organizationId, input, access.accountId);
    return Response.json({ note }, { status: 201 });
  } catch (error) {
    return clubMeetingNoteApiError(error, "Adding a meeting note");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
