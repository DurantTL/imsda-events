import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Eye, IdCard, UserCog } from "lucide-react";
import { ClubOverview } from "@/components/club-overview";
import { getCurrentSession } from "@/modules/access/current-session";
import { getPrisma } from "@/lib/prisma";

export const metadata: Metadata = { title: "Open club" };
export const dynamic = "force-dynamic";

/**
 * A club as its director sees it, for conference staff, view only (#386):
 * the club's admins, this year's roster, its events, and its monthly reports.
 * Changes are made on the staff screens linked here, never on the club's behalf.
 */
export default async function StaffOpenClubPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { organizationId } = await params;
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, name: true, isActive: true, parentOrganization: { select: { name: true } } },
  });
  if (!club || club.type !== "CLUB") notFound();

  return (
    <section className="page-stack">
      <div className="intro-actions club-admin-links">
        <Link className="secondary-button more-back-link" href="/admin/organizations">
          Back to churches and clubs
        </Link>
        <Link className="secondary-button" href={`/admin/organizations/${organizationId}/directors`}>
          <UserCog aria-hidden="true" size={14} /> Club admins
        </Link>
        <Link className="secondary-button" href={`/admin/organizations/${organizationId}/profile`}>
          <IdCard aria-hidden="true" size={14} /> Profile
        </Link>
      </div>

      <div className="page-intro">
        <div>
          <p className="eyebrow">Open club · view only</p>
          <h2 translate="no">{club.name}</h2>
          <p>
            {club.parentOrganization ? <>Sponsored by <span translate="no">{club.parentOrganization.name}</span>. </> : null}
            {club.isActive ? "" : "This club is inactive. "}
            This is what the club&apos;s director sees. Nothing can be changed here; showing birth dates is recorded.
          </p>
        </div>
      </div>

      <p className="inline-notice" role="status">
        <Eye aria-hidden="true" size={14} /> View only. Change club admins or the profile with the buttons above, and file
        or correct reports from Monthly reports.
      </p>

      <ClubOverview
        birthDatesEndpoint={`/api/admin/organizations/${encodeURIComponent(organizationId)}/roster/birth-dates`}
        organizationId={organizationId}
        reportHref={(month) => `/admin/clubs/reports/${organizationId}/${month}`}
        reportsEditable
      />
    </section>
  );
}
