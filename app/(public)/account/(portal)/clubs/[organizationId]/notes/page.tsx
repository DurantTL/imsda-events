import { redirect } from "next/navigation";

/** Meeting notes now live at the top of Monthly Records (#653); the old link still works. */
export default async function ClubMeetingNotesRedirect({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  redirect(`/account/clubs/${organizationId}/records`);
}
