import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/organizations/access";
import { honorApiError } from "@/modules/honors/api-errors";
import { createHonor, listHonors } from "@/modules/honors/repository";
import { honorInputSchema } from "@/modules/honors/schemas";
import { withRequestContext } from "@/lib/request-context";

async function getHandler() {
  try {
    await requireSystemAdministrator();
    return Response.json({ honors: await listHonors() });
  } catch (error) {
    return honorApiError(error, "Loading the honor catalog");
  }
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const input = honorInputSchema.parse(await request.json());
    return Response.json({ honors: await createHonor(input, actor.id) }, { status: 201 });
  } catch (error) {
    return honorApiError(error, "Adding an honor");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
