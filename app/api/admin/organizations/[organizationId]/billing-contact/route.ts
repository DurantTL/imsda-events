import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  BillingResponsibilityError,
  endOrganizationBillingContact,
  setOrganizationBillingContact,
  verifyOrganizationBillingContact,
} from "@/modules/billing-responsibility/repository";
import { billingContactActionSchema } from "@/modules/billing-responsibility/schemas";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * An organization's billing contact (#165). Conference-wide: reused by every event, so only a
 * system administrator may add, replace, verify or end it. Event finance staff cannot reach this.
 */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { organizationId } = await context.params;
    const body = billingContactActionSchema.parse(await request.json().catch(() => ({})));
    const who = { id: actor.id, globalRole: actor.globalRole };
    switch (body.action) {
      case "set":
        return Response.json(await setOrganizationBillingContact({ organizationId, contact: body.contact, actor: who }), { status: 201 });
      case "verify":
        return Response.json(await verifyOrganizationBillingContact({ organizationId, contactId: body.contactId, actor: who }));
      case "end":
        return Response.json(await endOrganizationBillingContact({ organizationId, contactId: body.contactId, reason: body.reason, actor: who }));
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_BILLING_CONTACT", message: error.issues[0]?.message ?? "Check the contact and try again." }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof BillingResponsibilityError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.code === "CONTACT_NOT_FOUND" ? 404 : error.code === "ORGANIZATION_NOT_ELIGIBLE" ? 404 : 409 });
    }
    logError("Billing contact request failed", error);
    return Response.json({ error: "BILLING_CONTACT_FAILED", message: "The change could not be saved." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
