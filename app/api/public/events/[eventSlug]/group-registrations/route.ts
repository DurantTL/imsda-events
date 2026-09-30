import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import { groupRegistrationApiError } from "@/modules/group-registrations/api-errors";
import { getGroupRegistrationExperience, submitGroupRegistration } from "@/modules/group-registrations/repository";
import { honorSelectionsSchema } from "@/modules/honors/registration-picks";
import { applyRateLimitHeaders, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkPublicRegistrationRateLimit } from "@/modules/rate-limit/service";
import { withRequestContext } from "@/lib/request-context";

const maximumBodyBytes = 512 * 1024;
const noStoreHeaders = { "Cache-Control": "no-store" };
/** Group registrations share one rate-limit form key per event, apart from the ordinary public form's. */
const GROUP_RATE_LIMIT_FORM = "group";

type Context = { params: Promise<{ eventSlug: string }> };

/** What the public "Group" page needs: the form without club questions, locations, classes, billing words. */
async function getHandler(_request: Request, context: Context) {
  try {
    const { eventSlug } = await context.params;
    const experience = await getGroupRegistrationExperience(eventSlug);
    return Response.json({ experience }, { headers: noStoreHeaders });
  } catch (error) {
    return groupRegistrationApiError(error, "Loading the group registration");
  }
}

/**
 * Registers a group: one contact and 1..N people, each with their own answers
 * and classes. Anonymous by design, so it is same-origin only, rate limited,
 * size capped, and every rule (pricing, ages, seats) is the server's. There is
 * no payment step: the contact is billed after the event.
 */
async function postHandler(request: Request, context: Context) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { eventSlug } = await context.params;
    rateLimit = await checkPublicRegistrationRateLimit(request, eventSlug, GROUP_RATE_LIMIT_FORM);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(
        Response.json({ error: "RATE_LIMITED", message: "Too many registration attempts. Try again later." }, { status: 429, headers: noStoreHeaders }),
        rateLimit,
      );
    }
    const body = await request.text();
    if (Buffer.byteLength(body) > maximumBodyBytes) {
      return applyRateLimitHeaders(
        Response.json({ error: "REQUEST_TOO_LARGE", message: "This registration request is too large." }, { status: 413, headers: noStoreHeaders }),
        rateLimit,
      );
    }
    // The location and class picks travel beside the form answers, never inside them.
    const { locationId, honorSelections, ...answers } = z.object({
      locationId: z.string().trim().min(1).max(100).nullish(),
      honorSelections: honorSelectionsSchema.optional(),
    }).loose().parse(JSON.parse(body));
    const input = publicRegistrationInputSchema.parse(answers);
    const result = await submitGroupRegistration(eventSlug, input, { locationId: locationId ?? null, ...(honorSelections ? { honorSelections } : {}) });
    return applyRateLimitHeaders(Response.json(result, { status: 201, headers: noStoreHeaders }), rateLimit);
  } catch (error) {
    const response = groupRegistrationApiError(error, "Submitting the group registration");
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
