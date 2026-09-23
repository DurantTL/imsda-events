import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireRosterAccess } from "@/modules/club-rosters/access";
import { clubRegistrationApiError } from "@/modules/club-registrations/api-errors";
import { submitClubRegistration } from "@/modules/club-registrations/repository";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
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

export const POST = withRequestContext(postHandler);
