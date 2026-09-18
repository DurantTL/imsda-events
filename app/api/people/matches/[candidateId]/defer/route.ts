import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/people/duplicate-match-access";
import { duplicateMatchApiError } from "@/modules/people/duplicate-match-api-errors";
import { deferMatchCandidate } from "@/modules/people/duplicate-match-repository";
import { withRequestContext } from "@/lib/request-context";

async function postHandler(
  request: Request,
  context: { params: Promise<{ candidateId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { candidateId } = await context.params;
    const result = await deferMatchCandidate(candidateId, actor.id);
    return Response.json({ candidate: result });
  } catch (error) {
    return duplicateMatchApiError(error, "Deferring a match candidate");
  }
}

export const POST = withRequestContext(postHandler);
