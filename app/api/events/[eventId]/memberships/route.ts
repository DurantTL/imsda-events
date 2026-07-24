import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getServerEnv } from "@/lib/env";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { issueAccountToken } from "@/modules/access/auth-service";
import { getCurrentSession } from "@/modules/access/current-session";
import { addStaffMembership, listStaffMemberships } from "@/modules/access/membership-repository";
import { eventRoles } from "@/modules/access/permissions";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";

const membershipSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(2).max(100),
  role: z.enum(eventRoles),
});

function apiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_MEMBERSHIP", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return Response.json({ error: "MEMBERSHIP_CONFLICT", message: "That staff account is already assigned." }, { status: 409 });
  logError("Staff membership request failed", error);
  return Response.json({ error: "MEMBERSHIP_REQUEST_FAILED", message: "The staff assignment could not be saved." }, { status: 500 });
}

export async function GET(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_STAFF", findActiveMembership);
    return Response.json({ memberships: await listStaffMemberships(eventId) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_STAFF", findActiveMembership);
    const input = membershipSchema.parse(await request.json());
    const result = await addStaffMembership(eventId, access.user.id, input);
    // The link is returned only to the authenticated administrator who just
    // created the account, and only when an account was actually created. That
    // is an out-of-band handoff, so it is shown in production too — otherwise
    // an invited colleague has no way to obtain a credential at all.
    const issued = result.credentialCreated ? await issueAccountToken(input.email) : null;
    const setupUrl = issued
      ? new URL(
          `/reset-password?token=${encodeURIComponent(issued.token)}`,
          getServerEnv().APP_BASE_URL,
        ).toString()
      : undefined;
    return Response.json({
      membership: result.membership,
      setupUrl,
      setupExpiresAt: issued?.expiresAt.toISOString(),
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
