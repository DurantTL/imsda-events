import { z } from "zod";
import { AccessDeniedError, effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { NoteError, createNote, listNotesForRegistration } from "@/modules/notes/repository";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_NOTE", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof NoteError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "FORBIDDEN" ? 403 : 404 });
  return Response.json({ error: "NOTE_REQUEST_FAILED", message: "The note request could not be completed." }, { status: 500 });
}

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string; registrationId: string }> }) {
  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "VIEW_SENSITIVE_DATA", findActiveMembership);
    const actorPermissions = new Set(effectivePermissions(access.user, access.membership));
    return Response.json({ notes: await listNotesForRegistration(eventId, registrationId, actorPermissions) });
  } catch (error) { return apiError(error); }
}

async function postHandler(request: Request, context: { params: Promise<{ eventId: string; registrationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_REGISTRATION", findActiveMembership);
    const note = await createNote(eventId, { registrationId }, access.user.id, await request.json());
    return Response.json({ note }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
