import { z } from "zod";
import { AccessDeniedError, requirePermission } from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import {
  BillingResponsibilityError,
  clearResponsibilityOverride,
  endOrganizationBillingContact,
  linkRegistrationToOrganization,
  resolveEventBillingResponsibility,
  setInvoiceGrouping,
  setOrganizationBillingContact,
  verifyOrganizationBillingContact,
} from "@/modules/billing-responsibility/repository";
import { billingResponsibilityActionSchema } from "@/modules/billing-responsibility/schemas";
import type { InvoiceGroupingMode } from "@/modules/billing-responsibility/domain";
import { findActiveMembership } from "@/modules/events/repository";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/**
 * Billing responsibility actions for a deferred-invoice event (#165): record who is responsible
 * for each registration, link or override one, change the invoice grouping, and manage an
 * organization's billing contact. MANAGE_FINANCE on the event in the URL, checked here, and the
 * service refuses anything that does not belong to that event. Same-origin only.
 */

type RouteContext = { params: Promise<{ eventId: string }> };

function statusFor(error: BillingResponsibilityError) {
  switch (error.code) {
    case "EVENT_NOT_FOUND":
    case "REGISTRATION_NOT_FOUND":
    case "CONTACT_NOT_FOUND":
    case "ORGANIZATION_NOT_RELEVANT":
      return 404;
    case "REASON_REQUIRED":
    case "ORGANIZATION_NOT_ELIGIBLE":
      return 400;
    default:
      return 409;
  }
}

async function postHandler(request: Request, context: RouteContext) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { eventId } = await context.params;
    const { user } = await requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE", findActiveMembership);
    const body = billingResponsibilityActionSchema.parse(await request.json().catch(() => ({})));
    const actorUserId = user.id;
    switch (body.action) {
      case "resolve": {
        const report = await resolveEventBillingResponsibility(eventId, { apply: body.apply, actorUserId });
        return Response.json({ report });
      }
      case "set-grouping": {
        const result = await setInvoiceGrouping({ eventId, invoiceGrouping: body.invoiceGrouping as InvoiceGroupingMode, actorUserId });
        return Response.json(result);
      }
      case "link": {
        const result = await linkRegistrationToOrganization({ eventId, registrationId: body.registrationId, organizationId: body.organizationId, reason: body.reason, actorUserId });
        return Response.json(result);
      }
      case "clear-override": {
        const result = await clearResponsibilityOverride({ eventId, registrationId: body.registrationId, reason: body.reason, actorUserId });
        return Response.json(result);
      }
      case "set-contact": {
        const result = await setOrganizationBillingContact({ eventId, organizationId: body.organizationId, contact: body.contact, actorUserId });
        return Response.json(result, { status: 201 });
      }
      case "verify-contact": {
        const result = await verifyOrganizationBillingContact({ eventId, organizationId: body.organizationId, contactId: body.contactId, actorUserId });
        return Response.json(result);
      }
      case "end-contact": {
        const result = await endOrganizationBillingContact({ eventId, organizationId: body.organizationId, contactId: body.contactId, reason: body.reason, actorUserId });
        return Response.json(result);
      }
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_BILLING_REQUEST", message: error.issues[0]?.message ?? "Check the request and try again." }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof BillingResponsibilityError) return Response.json({ error: error.code, message: error.message }, { status: statusFor(error) });
    logError("Billing responsibility request failed", error);
    return Response.json({ error: "BILLING_RESPONSIBILITY_FAILED", message: "The change could not be saved." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
