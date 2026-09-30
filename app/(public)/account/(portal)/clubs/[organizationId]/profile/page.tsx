import { redirect } from "next/navigation";

/** Club profile moved into Club info (#644); the old address lands on its section. */
export default async function ClubProfileRedirect({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  redirect(`/account/clubs/${organizationId}/club-info#club-profile`);
}
