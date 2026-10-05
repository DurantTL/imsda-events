import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import {
  getPublicRegistrationExperience,
  PublicRegistrationError,
  submitPublicRegistration,
} from "@/modules/forms/public-repository";
import {
  applyRateLimitHeaders,
  mergeRateLimitOutcomes,
  type RateLimitOutcome,
} from "@/modules/rate-limit/domain";
import { checkPublicFormRoommateLookupRateLimit, checkPublicRegistrationRateLimit, publicRequestClientHash } from "@/modules/rate-limit/service";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const maximumBodyBytes = 512 * 1024;
const noStoreHeaders = { "Cache-Control": "no-store" };

function errorResponse(error: unknown, rateLimit?: RateLimitOutcome) {
  let response: Response;
  if (error instanceof z.ZodError) {
    response = Response.json(
      { error: "INVALID_REQUEST", message: error.issues[0]?.message ?? "The registration request is invalid.", issues: error.issues },
      { status: 400, headers: noStoreHeaders }
    );
  } else if (error instanceof SyntaxError) {
    response = Response.json(
      { error: "INVALID_JSON", message: "The registration request is not valid JSON." },
      { status: 400, headers: noStoreHeaders }
    );
  } else if (error instanceof PublicRegistrationError) {
    let status = 409;
    if (error.code === "FORM_NOT_FOUND") status = 404;
    if (error.code === "REGISTRATION_CLOSED") status = 410;
    if (error.code === "INVALID_SUBMISSION") status = 422;
    response = Response.json(
      { error: error.code, message: error.message, issues: error.issues },
      { status, headers: noStoreHeaders }
    );
  } else {
    logError("Public registration request failed", error);
    response = Response.json(
      { error: "PUBLIC_REGISTRATION_FAILED", message: "The registration could not be completed. Nothing was charged or sent." },
      { status: 500, headers: noStoreHeaders }
    );
  }
  return rateLimit
    ? applyRateLimitHeaders(response, rateLimit)
    : response;
}

async function getHandler(
  _request: Request,
  context: { params: Promise<{ eventSlug: string; formSlug: string }> },
) {
  try {
    const { eventSlug, formSlug } = await context.params;
    const experience = await getPublicRegistrationExperience(eventSlug, formSlug);
    if (!experience) {
      return Response.json(
        { error: "FORM_NOT_FOUND", message: "That public registration form is not available." },
        { status: 404, headers: noStoreHeaders }
      );
    }
    return Response.json({ experience }, { status: 200, headers: noStoreHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

async function postHandler(request: Request, context: { params: Promise<{ eventSlug: string; formSlug: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  let rateLimit: RateLimitOutcome | undefined;
  try {
    const { eventSlug, formSlug } = await context.params;
    rateLimit = await checkPublicRegistrationRateLimit(
      request,
      eventSlug,
      formSlug
    );
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(Response.json(
        {
          error: "RATE_LIMITED",
          message: "Too many registration attempts. Try again later.",
        },
        { status: 429, headers: noStoreHeaders },
      ), rateLimit);
    }

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maximumBodyBytes) {
      return applyRateLimitHeaders(Response.json(
        { error: "REQUEST_TOO_LARGE", message: "This registration request is too large." },
        { status: 413, headers: noStoreHeaders },
      ), rateLimit);
    }

    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
      return applyRateLimitHeaders(Response.json(
        { error: "REQUEST_TOO_LARGE", message: "This registration request is too large." },
        { status: 413, headers: noStoreHeaders },
      ), rateLimit);
    }
    const input = publicRegistrationInputSchema.parse(JSON.parse(body));
    // Asking to room with someone by name and confirmation code can be used to guess codes: it has a tighter budget.
    if ((input.lodging?.roommates?.length ?? 0) > 0) {
      const lookupLimit = await checkPublicFormRoommateLookupRateLimit(request, eventSlug, formSlug);
      rateLimit = mergeRateLimitOutcomes(rateLimit, lookupLimit);
      if (!lookupLimit.allowed) {
        return applyRateLimitHeaders(Response.json(
          { error: "RATE_LIMITED", message: "Too many roommate lookups. Remove the roommate requests, or try again later." },
          { status: 429, headers: noStoreHeaders },
        ), rateLimit);
      }
    }
    let confirmation;
    try {
      confirmation = await submitPublicRegistration(eventSlug, formSlug, input);
    } catch (error) {
      // A roommate lookup that found nobody rolled the submission back, so it is audited here, by the hashed client and
      // the form only: never the typed name or code.
      if (error instanceof PublicRegistrationError && error.meta.roommateMiss && error.meta.eventId) {
        await writeAuditLog({
          eventId: error.meta.eventId,
          action: "LODGING_ROOMMATE_LOOKUP_MISSED",
          entityType: "RegistrationForm",
          entityId: formSlug.slice(0, 100),
          summary: "A roommate lookup on a registration form found no match.",
          metadata: { clientHash: publicRequestClientHash(request), formSlug: formSlug.slice(0, 100) },
        }).catch((auditError) => logError("Roommate lookup miss could not be audited", auditError));
      }
      throw error;
    }
    return applyRateLimitHeaders(
      Response.json({ confirmation }, { status: 201, headers: noStoreHeaders }),
      rateLimit
    );
  } catch (error) {
    return errorResponse(error, rateLimit);
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
