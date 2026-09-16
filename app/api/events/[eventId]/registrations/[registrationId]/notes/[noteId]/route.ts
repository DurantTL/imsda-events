import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { NoteError, addNoteRevision } from "@/modules/notes/repository";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_NOTE", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof NoteError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "FORBIDDEN" ? 403 : 404 });
  return Response.json({ error: "NOTE_REQUEST_FAILED", message: "The note request could not be completed." }, { status: 500 });
}

async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; registrationId: string; noteId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, noteId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_REGISTRATION", findActiveMembership);
    const note = await addNoteRevision(eventId, noteId, access.user.id, await request.json());
    return Response.json({ note });
  } catch (error) { return apiError(error); }
}

export const PATCH = withRequestContext(patchHandler);
