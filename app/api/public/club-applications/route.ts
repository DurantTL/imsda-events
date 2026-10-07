import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { withRequestContext } from "@/lib/request-context";
import { MAX_APPLICATION_ATTACHMENT_BYTES, newClubApplicationInputSchema } from "@/modules/club-applications/domain";
import { newClubApplicationApiError } from "@/modules/club-applications/api-errors";
import { submitNewClubApplication } from "@/modules/club-applications/repository";
import { applyRateLimitHeaders, mergeRateLimitOutcomes, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkNewClubApplicationEmailRateLimit, checkNewClubApplicationLinkRateLimit, checkNewClubApplicationSubmitRateLimit } from "@/modules/rate-limit/service";

/**
 * The public "Register a new club" submit (#817), open to anyone. It creates
 * nothing but a waiting application. Guarded the way the other public forms
 * are: same-origin only (CSRF), a per-client and per-director-email rate
 * limit, a size cap, a hidden field and a minimum fill time as the bot check.
 * The body is multipart: the answers as JSON in `data`, an optional file in
 * `attachment`, and `inviteToken` when the private link was used.
 */

const maximumBodyBytes = MAX_APPLICATION_ATTACHMENT_BYTES + 256 * 1024;
const headers = { "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" };

function limited(rateLimit: RateLimitOutcome) {
  return applyRateLimitHeaders(
    Response.json({ error: "RATE_LIMITED", message: "Too many applications from here. Try again later." }, { status: 429, headers }),
    rateLimit,
  );
}

async function postHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  let rateLimit: RateLimitOutcome | undefined;
  try {
    rateLimit = await checkNewClubApplicationSubmitRateLimit(request);
    if (!rateLimit.allowed) return limited(rateLimit);
    // The size cap needs a declared length: a request that doesn't say how big it is (chunked) is refused before anything is read.
    const declaredLength = request.headers.get("content-length");
    if (declaredLength === null || !/^\d+$/.test(declaredLength)) {
      return applyRateLimitHeaders(
        Response.json({ error: "LENGTH_REQUIRED", message: "The request must state its size." }, { status: 411, headers }),
        rateLimit,
      );
    }
    if (Number(declaredLength) > maximumBodyBytes) {
      return applyRateLimitHeaders(
        Response.json({ error: "REQUEST_TOO_LARGE", message: "The application is too large. Attach a file of 10 MB or less." }, { status: 413, headers }),
        rateLimit,
      );
    }
    const invalid = () => applyRateLimitHeaders(
      Response.json({ error: "INVALID_REQUEST", message: "Send the application form as a multipart form." }, { status: 400, headers }),
      rateLimit!,
    );
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      // Not a multipart body (JSON, plain text, or a broken form): a bad request, not a server fault.
      return invalid();
    }
    const data = form.get("data");
    if (typeof data !== "string") return invalid();
    let parsedData: unknown;
    try {
      parsedData = JSON.parse(data);
    } catch {
      return invalid();
    }
    const input = newClubApplicationInputSchema.parse(parsedData);
    // Once the director's email is known, its own per-address budget applies (the client budget was already charged once above).
    const emailLimit = await checkNewClubApplicationEmailRateLimit(input.directorEmail);
    rateLimit = mergeRateLimitOutcomes(rateLimit, emailLimit);
    if (!emailLimit.allowed) return limited(rateLimit);

    const attachment = form.get("attachment");
    const inviteToken = form.get("inviteToken");
    if (typeof inviteToken === "string" && inviteToken) {
      const linkLimit = await checkNewClubApplicationLinkRateLimit(request, inviteToken);
      rateLimit = mergeRateLimitOutcomes(rateLimit, linkLimit);
      if (!linkLimit.allowed) return limited(rateLimit);
    }
    await submitNewClubApplication(input, {
      attachment: attachment instanceof File ? attachment : null,
      inviteToken: typeof inviteToken === "string" && inviteToken ? inviteToken : null,
    });
    // The id stays inside; the applicant only needs to know it worked.
    return applyRateLimitHeaders(Response.json({ ok: true }, { status: 201, headers }), rateLimit);
  } catch (error) {
    const response = newClubApplicationApiError(error, "Submitting a new club application");
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}

export const POST = withRequestContext(postHandler);
