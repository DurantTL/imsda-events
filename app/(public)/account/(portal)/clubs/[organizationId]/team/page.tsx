import { redirect } from "next/navigation";

/** Club admins moved into Club info (#644); the old address lands on its section. */
export default async function ClubTeamRedirect({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  redirect(`/account/clubs/${organizationId}/club-info#club-team`);
}
