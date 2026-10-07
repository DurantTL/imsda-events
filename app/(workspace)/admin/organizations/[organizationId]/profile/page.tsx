import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubProfileForm } from "@/components/club-profile-form";
import { getCurrentSession } from "@/modules/access/current-session";
import { allowedReturnTo } from "@/lib/return-to";
import { getClubProfile, listSponsorOptions } from "@/modules/organizations/club-profile-repository";

export const metadata: Metadata = { title: "Club profile" };

/**
 * Conference staff edit any club's profile (#375). Reached from the churches
 * and clubs directory or from the club's own overview page (#428): the back
 * link returns to whichever sent the visitor here.
 */
export default async function StaffClubProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { organizationId } = await params;
  const { from } = await searchParams;
  const profile = await getClubProfile(organizationId);
  if (!profile) notFound();
  const sponsors = await listSponsorOptions(profile.sponsoringChurchId);
  const clubHref = `/admin/organizations/${organizationId}/club`;
  const backHref = allowedReturnTo(from, [clubHref], "/admin/organizations");
  const backLabel = backHref === clubHref ? `Back to ${profile.name}` : "Back to Clubs and churches";
  return (
    <section className="page-stack">
      <BackLink href={backHref} variant="staff">{backLabel}</BackLink>
      <ClubProfileForm
        sponsors={sponsors}
        endpoint={`/api/admin/organizations/${encodeURIComponent(organizationId)}/profile`}
        initialProfile={profile}
        variant="staff"
      />
    </section>
  );
}
