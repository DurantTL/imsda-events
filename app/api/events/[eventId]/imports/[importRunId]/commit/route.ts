import { Prisma } from "@prisma/client";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { commitImportRun, ImportOperationError } from "@/modules/imports/repository";
import { findActiveMembership } from "@/modules/events/repository";

export async function POST(request: Request, context: { params: Promise<{ eventId: string; importRunId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, importRunId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_IMPORTS", findActiveMembership);
    return Response.json({ run: await commitImportRun(eventId, importRunId, access.user.id) });
  } catch (error) {
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof ImportOperationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "IMPORT_NOT_FOUND" ? 404 : 409 });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return Response.json({ error: "IMPORT_CONFLICT", message: "The source data conflicts with a registration that changed after preview." }, { status: 409 });
    console.error("Import commit failed", error);
    return Response.json({ error: "IMPORT_COMMIT_FAILED", message: "The staging import could not be committed." }, { status: 500 });
  }
}
