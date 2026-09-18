import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/people/duplicate-match-access";
import { duplicateMatchApiError } from "@/modules/people/duplicate-match-api-errors";
import { dismissMatchCandidate } from "@/modules/people/duplicate-match-repository";
import { withRequestContext } from "@/lib/request-context";

const dismissInputSchema = z.object({
  reason: z.string().trim().min(5, "A dismissal reason of at least five characters is required."),
});

async function postHandler(
  request: Request,
  context: { params: Promise<{ candidateId: string }> },
) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const actor = await requireSystemAdministrator();
    const { candidateId } = await context.params;
    const { reason } = dismissInputSchema.parse(await request.json());
    const candidate = await dismissMatchCandidate(candidateId, actor.id, reason);
    return Response.json({ candidate });
  } catch (error) {
    return duplicateMatchApiError(error, "Dismissing a match candidate");
  }
}

export const POST = withRequestContext(postHandler);
