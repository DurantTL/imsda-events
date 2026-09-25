import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubProfileForm } from "@/components/club-profile-form";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { getClubProfile, listChurchOptions } from "@/modules/organizations/club-profile-repository";

export const metadata: Metadata = { title: "Club profile" };
export const dynamic = "force-dynamic";

/** The club's director or deputy keeps the club profile current (#375). */
export default async function ClubProfilePage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state !== "OPEN") return null;
  const back = <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>;
  if (!access.capabilities.editProfile) {
    return (
      <>
        {back}
        <p className="public-manage-empty">Only the club&apos;s director or deputy can change the club profile.</p>
      </>
    );
  }
  const profile = await getClubProfile(organizationId);
  if (!profile) return null;
  const churches = await listChurchOptions(profile.sponsoringChurchId);
  return (
    <>
      {back}
      <ClubProfileForm
        churches={churches}
        endpoint={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/profile`}
        initialProfile={profile}
      />
    </>
  );
}
