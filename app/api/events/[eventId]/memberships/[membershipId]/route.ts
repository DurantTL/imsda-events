import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { MembershipOperationError, updateStaffMembership } from "@/modules/access/membership-repository";
import { eventRoles } from "@/modules/access/permissions";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { findActiveMembership } from "@/modules/events/repository";

const updateSchema = z.object({ role: z.enum(eventRoles), status: z.enum(["ACTIVE", "INACTIVE"]) });

export async function PATCH(request: Request, context: { params: Promise<{ eventId: string; membershipId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId, membershipId } = await context.params;
    const access = await requirePermission(await getCurrentSession(), eventId, "MANAGE_STAFF", findActiveMembership);
    const membership = await updateStaffMembership(eventId, membershipId, access.user.id, updateSchema.parse(await request.json()));
    return Response.json({ membership });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "INVALID_MEMBERSHIP", message: error.issues[0]?.message }, { status: 400 });
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof MembershipOperationError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "MEMBERSHIP_NOT_FOUND" ? 404 : 409 });
    console.error("Staff membership update failed", error);
    return Response.json({ error: "MEMBERSHIP_UPDATE_FAILED", message: "The staff assignment could not be updated." }, { status: 500 });
  }
}
