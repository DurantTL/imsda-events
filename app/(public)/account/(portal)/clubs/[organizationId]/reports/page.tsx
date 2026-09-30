import { redirect } from "next/navigation";

/** The monthly reports list is now part of Monthly Records (#653); the old link still works. */
export default async function ClubReportsRedirect({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  redirect(`/account/clubs/${organizationId}/records`);
}
