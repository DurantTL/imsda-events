import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProfileView } from "@/components/profile-view";
import {
  loadProfileData,
  profileHomeFor,
  resolveProfileSessions,
  twoStepQuery,
} from "@/modules/account-profile/load-profile";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Edit profile" };

/**
 * `/profile` for anyone with a staff session (#646): it lives under the
 * `(workspace)` layout, so opening it from the staff account menu is a
 * client-side navigation with the shell (sidebar, header, event context) kept.
 * A browser with only a registration account is sent to `/account/profile`
 * (inside the attendee portal); with neither, to the sign-in chooser. Staff and
 * attendee sessions stay separate (ADR 0003); the shared view shows a section
 * per session that exists. No event is needed.
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ twoStep?: string | string[] }>;
}) {
  const { twoStep } = await searchParams;
  const sessions = await resolveProfileSessions();
  if (!sessions.staff) redirect(profileHomeFor(sessions, twoStepQuery(twoStep)));
  return <ProfileView data={await loadProfileData(sessions, twoStep)} variant="shell" />;
}
