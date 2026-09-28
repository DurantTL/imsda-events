import { redirect } from "next/navigation";
import { requireAttendeeSecondStep } from "@/modules/attendee-accounts/portal-second-step";

export const dynamic = "force-dynamic";

/**
 * Moved to the one Edit profile page (#543). Kept so emails and help links
 * still work; a pending club second step is still sent to /account/two-step
 * first, exactly as before.
 */
export default async function AttendeeProfilePage() {
  await requireAttendeeSecondStep();
  redirect("/profile");
}
