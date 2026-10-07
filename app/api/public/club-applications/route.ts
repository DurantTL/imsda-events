import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { withRequestContext } from "@/lib/request-context";
import { MAX_APPLICATION_ATTACHMENT_BYTES, newClubApplicationInputSchema } from "@/modules/club-applications/domain";
import { newClubApplicationApiError } from "@/modules/club-applications/api-errors";
import { submitNewClubApplication } from "@/modules/club-applications/repository";
import { applyRateLimitHeaders, mergeRateLimitOutcomes, type RateLimitOutcome } from "@/modules/rate-limit/domain";
import { checkNewClubApplicationLinkRateLimit, checkNewClubApplicationSubmitRateLimit } from "@/modules/rate-limit/service";

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
    if (Number(request.headers.get("content-length") ?? 0) > maximumBodyBytes) {
      return applyRateLimitHeaders(
        Response.json({ error: "REQUEST_TOO_LARGE", message: "The application is too large. Attach a file of 10 MB or less." }, { status: 413, headers }),
        rateLimit,
      );
    }
    const form = await request.formData();
    const data = form.get("data");
    if (typeof data !== "string") throw new SyntaxError("Missing form data.");
    const input = newClubApplicationInputSchema.parse(JSON.parse(data));
    // Once the director's email is known, the per-address budget applies too.
    const emailLimit = await checkNewClubApplicationSubmitRateLimit(request, input.directorEmail);
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
