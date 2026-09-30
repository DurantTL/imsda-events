import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProfileView } from "@/components/profile-view";
import {
  loadProfileData,
  resolveProfileSessions,
  twoStepQuery,
} from "@/modules/account-profile/load-profile";
import { requireAttendeeSecondStep } from "@/modules/attendee-accounts/portal-second-step";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Edit profile",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The attendee/director profile (#646), rendered inside the portal layout
 * (header, tabs, announcement banner) so opening it from the portal nav never
 * leaves the portal. A club role that hasn't passed its second step is sent to
 * /account/two-step first, as on every account page. A browser with no
 * registration account here (a staff "act as", or staff only) goes to
 * `/profile`, which sends anyone with no session to the sign-in chooser.
 */
export default async function AttendeeProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ twoStep?: string | string[] }>;
}) {
  const { twoStep } = await searchParams;
  await requireAttendeeSecondStep();
  const sessions = await resolveProfileSessions();
  if (!sessions.attendeeAccount) redirect(`/profile${twoStepQuery(twoStep)}`);
  return <ProfileView data={await loadProfileData(sessions, twoStep)} variant="portal" />;
}
