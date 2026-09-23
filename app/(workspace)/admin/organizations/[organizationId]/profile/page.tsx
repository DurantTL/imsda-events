import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ClubProfileForm } from "@/components/club-profile-form";
import { getCurrentSession } from "@/modules/access/current-session";
import { getClubProfile, listChurchOptions } from "@/modules/organizations/club-profile-repository";

export const metadata: Metadata = { title: "Club profile" };

/** Conference staff edit any club's profile (#375). */
export default async function StaffClubProfilePage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { organizationId } = await params;
  const profile = await getClubProfile(organizationId);
  if (!profile) notFound();
  const churches = await listChurchOptions(profile.sponsoringChurchId);
  return (
    <section className="page-stack">
      <Link className="secondary-button more-back-link" href="/admin/organizations">
        Back to churches and clubs
      </Link>
      <ClubProfileForm
        churches={churches}
        endpoint={`/api/admin/organizations/${encodeURIComponent(organizationId)}/profile`}
        initialProfile={profile}
        variant="staff"
      />
    </section>
  );
}
