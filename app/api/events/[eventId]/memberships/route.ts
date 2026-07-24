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
import { sendStaffInvitationEmail } from "@/modules/communications/account-email-dispatch";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

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

async function getHandler(_request: Request, context: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await context.params;
    await requirePermission(await getCurrentSession(), eventId, "MANAGE_STAFF", findActiveMembership);
    return Response.json({ memberships: await listStaffMemberships(eventId) });
  } catch (error) { return apiError(error); }
}

async function postHandler(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_STAFF", findActiveMembership);
    const input = membershipSchema.parse(await request.json());
    const result = await addStaffMembership(eventId, access.user.id, input);
    // An invited colleague is emailed their activation link. Only where email
    // is not configured — development, since production requires it at startup
    // — is a link handed back for the administrator to pass on out of band.
    const invited = result.credentialCreated
      ? await sendStaffInvitationEmail({
          userId: result.membership.user.id,
          email: input.email,
          displayName: input.displayName,
        })
      : { configured: true, queued: false };
    const issued = result.credentialCreated && !invited.configured
      ? await issueAccountToken(input.email)
      : null;
    const setupUrl = issued
      ? new URL(
          `/reset-password?token=${encodeURIComponent(issued.token)}`,
          getServerEnv().APP_BASE_URL,
        ).toString()
      : undefined;
    return Response.json({
      membership: result.membership,
      invitationEmailed: invited.queued,
      setupUrl,
      setupExpiresAt: issued?.expiresAt.toISOString(),
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
