import { z } from "zod";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { attendeeSecondStepPending } from "@/modules/attendee-accounts/portal-second-step";
import {
  attendeeProfileSchema,
  getAttendeeProfile,
  updateAttendeeProfile,
} from "@/modules/attendee-accounts/profile-service";
import { withRequestContext } from "@/lib/request-context";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...privateHeaders, ...init?.headers },
  });
}

async function account() {
  const current = await getCurrentAttendee();
  return current.via === "attendee" ? current.account : null;
}

/** Same role-dependent second step the portal enforces (decision 2026-09-23, #736). */
function secondStepRequired() {
  return json(
    { code: "SECOND_STEP_REQUIRED", message: "Finish two-step sign-in to manage your profile." },
    { status: 403 },
  );
}

async function getHandler() {
  const attendee = await account();
  if (!attendee) return json({ message: "Sign in to manage your profile." }, { status: 401 });
  if (await attendeeSecondStepPending()) return secondStepRequired();
  return json({ profile: await getAttendeeProfile(attendee.id) });
}

async function patchHandler(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  const attendee = await account();
  if (!attendee) return json({ message: "Sign in to manage your profile." }, { status: 401 });
  if (await attendeeSecondStepPending()) return secondStepRequired();
  try {
    const input = attendeeProfileSchema.parse(await request.json());
    return json({ profile: await updateAttendeeProfile(attendee.id, input) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json({
        message: error.issues[0]?.message ?? "Review your profile and try again.",
        issues: error.issues,
      }, { status: 400 });
    }
    throw error;
  }
}

export const GET = withRequestContext(getHandler);
export const PATCH = withRequestContext(patchHandler);
