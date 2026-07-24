import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { getRegistrationById, updateRegistration } from "@/modules/registrations/repository";
import { registrationUpdateSchema } from "@/modules/registrations/schemas";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_REGISTRATION", issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return Response.json({ error: "EMAIL_ALREADY_IN_USE", message: "That email is already assigned to another person." }, { status: 409 });
  }
  logError("Registration detail request failed", error);
  return Response.json({ error: "REGISTRATION_DETAIL_FAILED" }, { status: 500 });
}

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string; registrationId: string }> }) {
  try {
    const { eventId, registrationId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "VIEW_SENSITIVE_DATA", findActiveMembership);
    const registration = await getRegistrationById(eventId, registrationId);
    return registration ? Response.json({ registration }) : Response.json({ error: "REGISTRATION_NOT_FOUND" }, { status: 404 });
  } catch (error) {
    return apiError(error);
  }
}

async function patchHandler(request: Request, context: { params: Promise<{ eventId: string; registrationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, registrationId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_REGISTRATION", findActiveMembership);
    const input = registrationUpdateSchema.parse(await request.json());
    const registration = await updateRegistration(eventId, registrationId, input, access.user.id);
    return registration ? Response.json({ registration }) : Response.json({ error: "REGISTRATION_NOT_FOUND" }, { status: 404 });
  } catch (error) {
    return apiError(error);
  }
}

export const GET = withRequestContext(getHandler);
export const PATCH = withRequestContext(patchHandler);
