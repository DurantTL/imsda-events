import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Eye } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { ClubHonorsWorkspace } from "@/components/club-honors-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { getPrisma } from "@/lib/prisma";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { listActiveHonorOptions, listClubHonorsPage } from "@/modules/honors/member-honor-repository";

export const metadata: Metadata = { title: "Club honors" };
export const dynamic = "force-dynamic";

/**
 * A club's member honors for conference staff (#591). View only, except that a
 * system administrator can void a mistaken entry from a member's history,
 * whichever club recorded it and whether or not that club is still active.
 */
export default async function StaffClubHonorsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams?: Promise<{ year?: string | string[] }>;
}) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { organizationId } = await params;
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, name: true, isActive: true },
  });
  if (!club || club.type !== "CLUB") notFound();
  // The roster's year, carried by its Honors link (#819); an unlisted year falls back to the current one.
  const clubYear = rosterYearView((await searchParams)?.year).clubYear;
  const [rows, honors] = await Promise.all([
    listClubHonorsPage(organizationId, clubYear),
    listActiveHonorOptions(),
  ]);
  return (
    <section className="page-stack">
      <BackLink href={`/admin/organizations/${organizationId}/club`} variant="staff">Back to {club.name}</BackLink>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Club honors · staff</p>
          <h2 translate="no">{club.name}</h2>
          {club.isActive ? null : <p>This club is inactive.</p>}
        </div>
      </div>
      <p className="inline-notice" role="status">
        <Eye aria-hidden="true" size={14} /> View only. Open a member&apos;s history to void a mistaken entry; a void is recorded
        with your name and can&apos;t be undone.
      </p>
      <ClubHonorsWorkspace
        clubYear={clubYear}
        honorOptions={honors}
        initialRows={rows}
        organizationId={organizationId}
        readOnly
        staff
      />
    </section>
  );
}
