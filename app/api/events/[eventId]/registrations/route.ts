import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { createRegistration, listRegistrations } from "@/modules/registrations/repository";
import { registrationInputSchema } from "@/modules/registrations/schemas";

async function authorize(eventId: string, permission: "VIEW_SENSITIVE_DATA" | "MANAGE_REGISTRATION") {
  return requirePermission(await getCurrentSession(), eventId, permission, findActiveMembership);
}

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: "INVALID_REGISTRATION", issues: error.issues }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return Response.json({ error: "EMAIL_ALREADY_IN_USE", message: "That email is already assigned to another person." }, { status: 409 });
  }
  console.error("Registration request failed", error);
  return Response.json({ error: "REGISTRATION_REQUEST_FAILED" }, { status: 500 });
}

export async function GET(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await authorize(eventId, "VIEW_SENSITIVE_DATA");
    return Response.json({ registrations: await listRegistrations(eventId) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await authorize(eventId, "MANAGE_REGISTRATION");
    const input = registrationInputSchema.parse(await request.json());
    const registration = await createRegistration(eventId, input, access.user.id);
    return Response.json({ registration }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
