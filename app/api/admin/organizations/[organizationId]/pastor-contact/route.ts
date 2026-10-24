import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { OrganizationContactError, endPastorContact, setPastorContact } from "@/modules/organizations/contacts-repository";
import { organizationContactActionSchema } from "@/modules/organizations/contacts-schemas";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

/** A church's pastor contact (#977): office (system administrator) only. Nothing is sent to the pastor. */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator("System administrator access is required to manage a church's pastor contact.");
    const { organizationId } = await context.params;
    const body = organizationContactActionSchema.parse(await request.json().catch(() => ({})));
    const who = { id: actor.id, globalRole: actor.globalRole };
    switch (body.action) {
      case "set":
        return Response.json(await setPastorContact({ organizationId, contact: body.contact, actor: who }), { status: 201 });
      case "end":
        return Response.json(await endPastorContact({ organizationId, contactId: body.contactId, reason: body.reason, actor: who }));
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "INVALID_PASTOR_CONTACT", message: error.issues[0]?.message ?? "Check the contact and try again." }, { status: 400 });
    }
    if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof OrganizationContactError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.code === "CONCURRENT_CHANGE" ? 409 : error.code === "INVALID_CONTACT" ? 400 : 404 });
    }
    logError("Pastor contact request failed", error);
    return Response.json({ error: "PASTOR_CONTACT_FAILED", message: "The change could not be saved." }, { status: 500 });
  }
}

export const POST = withRequestContext(postHandler);
