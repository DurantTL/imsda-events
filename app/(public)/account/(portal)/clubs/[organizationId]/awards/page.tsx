import { redirect } from "next/navigation";

/** "Earned awards" became "Class tracking" (#644); the old address keeps working. */
export default async function ClubAwardsRedirect({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  redirect(`/account/clubs/${organizationId}/class-tracking`);
}
