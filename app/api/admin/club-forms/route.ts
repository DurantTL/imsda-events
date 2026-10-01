import { withRequestContext } from "@/lib/request-context";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { clubFormApiError, readClubFormJson } from "@/modules/club-forms/api-errors";
import { createClubFormTemplate } from "@/modules/club-forms/builder";
import { createTemplateSchema } from "@/modules/club-forms/builder-domain";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/** A system administrator creates a club form, blank or as a copy of another (#712). It starts disabled. */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const admin = await requireSystemAdministrator();
    const input = createTemplateSchema.parse(await readClubFormJson(request));
    return Response.json(await createClubFormTemplate(input, admin.id), {
      status: 201,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return clubFormApiError(error, "Creating a club form");
  }
}

export const POST = withRequestContext(postHandler);
