import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubReportApiError } from "@/modules/club-reports/api-errors";
import { setRegistrationOnTime } from "@/modules/club-reports/repository";
import { registrationStandingSchema } from "@/modules/club-reports/schemas";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { withRequestContext } from "@/lib/request-context";

/** Staff mark a club's yearly registration as on time (1,500 points) or not (#377). */
async function patchHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const input = registrationStandingSchema.parse(await request.json());
    await setRegistrationOnTime(input.organizationId, input.clubYear, input.registrationOnTime, actor.id);
    return Response.json({ ok: true });
  } catch (error) {
    return clubReportApiError(error, "Saving the registration standing");
  }
}

export const PATCH = withRequestContext(patchHandler);
