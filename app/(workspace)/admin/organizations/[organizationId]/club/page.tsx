import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Eye, IdCard, UserCog } from "lucide-react";
import { ActAsButton } from "@/components/act-as-button";
import { BackLink } from "@/components/back-link";
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
  const selfHref = `/admin/organizations/${organizationId}/club`;
  const fromHere = `?from=${encodeURIComponent(selfHref)}`;

  return (
    <section className="page-stack">
      <div className="intro-actions club-admin-links">
        <BackLink href="/admin/organizations" variant="staff">Back to churches and clubs</BackLink>
        <Link className="secondary-button" href={`/admin/organizations/${organizationId}/directors${fromHere}`}>
          <UserCog aria-hidden="true" size={14} /> Club admins
        </Link>
        <Link className="secondary-button" href={`/admin/organizations/${organizationId}/profile${fromHere}`}>
          <IdCard aria-hidden="true" size={14} /> Club profile
        </Link>
        <ActAsButton
          confirmText={`Act as ${club.name}'s Director for the next 2 hours? Your own account gets a real Director role (recorded, shown in Club admins, and ending by itself), so you can see and fix things exactly as the director would.`}
          endpoint={`/api/admin/organizations/${encodeURIComponent(organizationId)}/act-as-director`}
          label="Act as Director (2 hours)"
        />
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
        backgroundChecks={{ includeNotes: true }}
        birthDatesEndpoint={`/api/admin/organizations/${encodeURIComponent(organizationId)}/roster/birth-dates`}
        organizationId={organizationId}
        reportHref={(month) => `/admin/clubs/reports/${organizationId}/${month}${fromHere}`}
        reportsEditable
      />
    </section>
  );
}
