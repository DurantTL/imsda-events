import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { clubRegistrationApiError } from "@/modules/club-registrations/api-errors";
import { clubRegistrationEditInputSchema } from "@/modules/club-registrations/domain";
import { amendClubRegistration, submitClubRegistration } from "@/modules/club-registrations/repository";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const maximumBodyBytes = 512 * 1024;

/** Submits the club's registration. Same idempotency key, same result. */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string; eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, eventId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "registerForEvents");
    const body = await request.text();
    if (Buffer.byteLength(body) > maximumBodyBytes) {
      return Response.json({ error: "REQUEST_TOO_LARGE", message: "This registration is too large." }, { status: 413 });
    }
    const input = publicRegistrationInputSchema.parse(JSON.parse(body));
    const confirmation = await submitClubRegistration(organizationId, eventId, access.accountId, input);
    return Response.json({ confirmation }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubRegistrationApiError(error, "Submitting the club registration");
  }
}

/**
 * Reopens a submitted club registration to add or remove people, or change
 * their answers (H3b, #366), through the staff amendment engine with a
 * director actor. Server-side authorization only: the director must be a
 * current, non-revoked director (or deputy/registrar) of this club, checked
 * fresh on every request by `requireRosterAccess`.
 */
async function patchHandler(request: Request, context: { params: Promise<{ organizationId: string; eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, eventId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "registerForEvents");
    const body = await request.text();
    if (Buffer.byteLength(body) > maximumBodyBytes) {
      return Response.json({ error: "REQUEST_TOO_LARGE", message: "This registration is too large." }, { status: 413 });
    }
    const input = clubRegistrationEditInputSchema.parse(JSON.parse(body));
    const { pendingMessageIds, ...result } = await amendClubRegistration(organizationId, eventId, access.accountId, input);
    try {
      await processQueuedMessageIdsAfterCommit(pendingMessageIds);
    } catch (error) {
      logError("Club registration edit notice processing failed after commit", error);
    }
    return Response.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubRegistrationApiError(error, "Updating the club registration");
  }
}

export const POST = withRequestContext(postHandler);
export const PATCH = withRequestContext(patchHandler);
