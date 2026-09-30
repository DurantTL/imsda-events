import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { clubRegistrationApiError } from "@/modules/club-registrations/api-errors";
import { clubRegistrationEditInputSchema } from "@/modules/club-registrations/domain";
import { amendClubRegistration, submitClubRegistration } from "@/modules/club-registrations/repository";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import { ClassSelectionError, saveRegistrationHonorPicks } from "@/modules/honors/enrollment-repository";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

const maximumBodyBytes = 512 * 1024;

/** Honors picked while registering (#618), by the event form's client id. Beside the answers, never inside them. */
const honorSelectionsSchema = z.record(z.string().min(1).max(80), z.array(z.string().min(1).max(64)).max(6))
  .refine((picks) => Object.keys(picks).length <= 60, "Too many people in one save.");

/** Submits the club's registration. Same idempotency key, same result. */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string; eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, eventId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "registerForEvents");
    const body = await request.text();
    if (Buffer.byteLength(body) > maximumBodyBytes) {
      return Response.json({ error: "REQUEST_TOO_LARGE", message: "This registration is too large." }, { status: 413 });
    }
    // The picked location travels beside the form answers, never inside them (#413).
    const { locationId, honorSelections, ...answers } = z.object({
      locationId: z.string().trim().min(1).max(100).nullish(),
      honorSelections: honorSelectionsSchema.optional(),
    }).loose().parse(JSON.parse(body));
    const input = publicRegistrationInputSchema.parse(answers);
    const confirmation = await submitClubRegistration(
      organizationId,
      eventId,
      actorAttribution(access.actor),
      input,
      new Date(),
      { locationId: locationId ?? null },
    );
    // The registration is saved either way. The picks go through the same
    // enrollment rules as the class picker; if a class filled up meanwhile the
    // director is told, and picks again on the registered page.
    let honors: { saved: number } | { error: string } | null = null;
    if (honorSelections && Object.values(honorSelections).some((ids) => ids.length > 0)) {
      try {
        honors = await saveRegistrationHonorPicks(organizationId, eventId, actorAttribution(access.actor), honorSelections);
      } catch (error) {
        if (!(error instanceof ClassSelectionError)) logError("Saving honors picked during club registration failed", error);
        honors = {
          error: error instanceof ClassSelectionError && error.code !== "NOT_REGISTERED"
            ? error.message
            : "Your registration is saved, but your honors were not. Choose them below once the registration is confirmed.",
        };
      }
    }
    return Response.json({ confirmation, honors }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubRegistrationApiError(error, "Submitting the club registration");
  }
}

/**
 * Reopens a submitted club registration to add or remove people, or change
 * their answers (H3b, #366), through the staff amendment engine with a
 * director actor. Server-side authorization only: the director must be a
 * current, non-revoked director (or deputy/registrar) of this club, checked
 * fresh on every request by `requireRosterAccess`.
 */
async function patchHandler(request: Request, context: { params: Promise<{ organizationId: string; eventId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId, eventId } = await context.params;
    const access = await requireRosterAccess(organizationId, new Date(), "registerForEvents");
    const body = await request.text();
    if (Buffer.byteLength(body) > maximumBodyBytes) {
      return Response.json({ error: "REQUEST_TOO_LARGE", message: "This registration is too large." }, { status: 413 });
    }
    const input = clubRegistrationEditInputSchema.parse(JSON.parse(body));
    // Only the club's own summary: never the staff view of the registration.
    const { pendingMessageIds, result } = await amendClubRegistration(organizationId, eventId, actorAttribution(access.actor), input);
    try {
      await processQueuedMessageIdsAfterCommit(pendingMessageIds);
    } catch (error) {
      logError("Club registration edit notice processing failed after commit", error);
    }
    return Response.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clubRegistrationApiError(error, "Updating the club registration");
  }
}

export const POST = withRequestContext(postHandler);
export const PATCH = withRequestContext(patchHandler);
