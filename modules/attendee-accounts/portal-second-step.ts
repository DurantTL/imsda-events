import "server-only";

import { redirect } from "next/navigation";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { accountNeedsSecondStep } from "@/modules/attendee-accounts/sign-in-gate";

/**
 * Whether this browser's attendee session belongs to a club role or Area
 * Coordinator that hasn't passed its second step yet (decision 2026-09-23).
 */
export async function attendeeSecondStepPending() {
  const { account, via, sessionId } = await getCurrentAttendee();
  if (!account || via !== "attendee") return false;
  return (await accountNeedsSecondStep(account.id, sessionId)) !== "OK";
}

/**
 * For portal pages that show the attendee's own account. The portal layout
 * no longer sends everyone to /account/two-step while a staff "act as" is
 * active (#442) — act-as pages resolve purely from the staff session — so a
 * page that reads the attendee account checks the second step itself.
 */
export async function requireAttendeeSecondStep() {
  if (await attendeeSecondStepPending()) redirect("/account/two-step");
}
