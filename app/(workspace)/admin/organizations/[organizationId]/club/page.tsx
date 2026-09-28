import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Eye, IdCard, UserCog } from "lucide-react";
import { ActAsButton } from "@/components/act-as-button";
import { BackLink } from "@/components/back-link";
import { ClubImportYearMove } from "@/components/club-import-year-move";
import { ClubOverview } from "@/components/club-overview";
import { getCurrentSession } from "@/modules/access/current-session";
import { listClubImports } from "@/modules/club-imports/move-year";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { getPrisma } from "@/lib/prisma";

export const metadata: Metadata = { title: "Open club" };
export const dynamic = "force-dynamic";

/**
 * A club as its director sees it, for conference staff, view only (#386):
 * the club's admins, this year's roster, its events, and its monthly reports.
 * Changes are made on the staff screens linked here, never on the club's behalf.
 * `?year=` shows the previous or next club year's roster, read-only (#541),
 * so an import can be checked in the year it went into. The one change made
 * here is moving a club import to another club year (system administrators).
 */
export default async function StaffOpenClubPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams?: Promise<{ year?: string | string[] }>;
}) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const [{ organizationId }, query] = await Promise.all([params, searchParams]);
  const view = rosterYearView(query?.year);
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, name: true, isActive: true, parentOrganization: { select: { name: true } } },
  });
  if (!club || club.type !== "CLUB") notFound();
  const imports = await listClubImports(organizationId);
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
          access="Full director powers, attributed to you"
          club={club.name}
          endpoint={`/api/admin/organizations/${encodeURIComponent(organizationId)}/act-as-director`}
          label="Act as Director (2 hours)"
          resultAction="Open the club portal"
          role="Director"
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

      <nav aria-label="Roster club year" className="intro-actions club-year-choice">
        {view.choices.map((year) => (
          <Link
            aria-current={year === view.clubYear ? "page" : undefined}
            className={year === view.clubYear ? "primary-button" : "secondary-button"}
            href={year === view.currentClubYear ? selfHref : `${selfHref}?year=${encodeURIComponent(year)}`}
            key={year}
          >
            {year}{year === view.currentClubYear ? " (current)" : ""}
          </Link>
        ))}
      </nav>
      {view.readOnly && (
        <p className="inline-notice" role="status">
          Showing the {view.clubYear} roster, read-only. Everything else on this page is for {view.currentClubYear}.
        </p>
      )}

      <ClubOverview
        backgroundChecks={{ includeNotes: true }}
        birthDatesEndpoint={`/api/admin/organizations/${encodeURIComponent(organizationId)}/roster/birth-dates`}
        organizationId={organizationId}
        reportHref={(month) => `/admin/clubs/reports/${organizationId}/${month}${fromHere}`}
        reportsEditable
        rosterYear={view.clubYear}
      />

      {/* Keyed by the imports' years, so the panel starts fresh after a move refreshes the page. */}
      {imports.length > 0 && (
        <ClubImportYearMove
          imports={imports}
          key={imports.map((item) => item.clubYear).join(",")}
          organizationId={organizationId}
          yearChoices={view.choices}
        />
      )}
    </section>
  );
}
