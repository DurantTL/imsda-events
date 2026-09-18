import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { requireSystemAdministrator } from "@/modules/people/duplicate-match-access";
import { duplicateMatchApiError } from "@/modules/people/duplicate-match-api-errors";
import {
  generateMatchCandidates,
  listOpenMatchCandidates,
} from "@/modules/people/duplicate-match-repository";
import { withRequestContext } from "@/lib/request-context";

/** Lists open match candidates for the review queue. */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    return Response.json({ candidates: await listOpenMatchCandidates() });
  } catch (error) {
    return duplicateMatchApiError(error, "Loading match candidates");
  }
}

/**
 * Runs candidate generation. Idempotent and safe to call repeatedly — see
 * `generateMatchCandidates`. This never applies a candidate; it only
 * computes and stores evidence for staff to review.
 */
async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    await requireSystemAdministrator();
    const result = await generateMatchCandidates();
    return Response.json({ result, candidates: await listOpenMatchCandidates() });
  } catch (error) {
    return duplicateMatchApiError(error, "Generating match candidates");
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
