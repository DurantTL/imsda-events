import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { AreaClubEvents, AreaClubsOverview, AreaExportLinks, AreaMonthlyReportsTable, AreaPointsChart } from "@/components/area-clubs-views";
import { getCurrentSession } from "@/modules/access/current-session";
import { parseLeaderboardSort } from "@/modules/club-reports/area-summary-domain";
import { resolveAreaClubYear } from "@/modules/club-reports/area-export";
import { getAreaClubsSummary, listAreaClubEvents } from "@/modules/club-reports/area-summary-repository";

export const metadata: Metadata = { title: "Club summary" };
export const dynamic = "force-dynamic";

/** The same cross-club summary an Area Coordinator sees, for the conference office (#657). */
export default async function ClubSummaryAdminPage({ searchParams }: { searchParams: Promise<{ year?: string; sort?: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const params = await searchParams;
  const clubYear = resolveAreaClubYear(params.year);
  const [clubs, events] = await Promise.all([getAreaClubsSummary(clubYear), listAreaClubEvents(clubYear)]);
  const links = {
    clubHref: (id: string) => `/admin/organizations/${id}/club`,
    reportHref: (id: string, month: string) => `/admin/clubs/reports/${id}/${month}`,
  };
  return (
    <section className="page-stack">
      <div className="intro-actions club-admin-links">
        <BackLink href="/admin/organizations" variant="staff">Back to Clubs and churches</BackLink>
        <Link className="secondary-button" href="/admin/clubs/reports">Monthly reports</Link>
      </div>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Clubs · {clubYear}</p>
          <h2>Club summary</h2>
          <p>Every active club&apos;s reports and points, as Area Coordinators see them. Background checks are counts only.</p>
        </div>
        <AreaExportLinks
          basePath="/api/admin/club-reports/area-export"
          clubYear={clubYear}
          reports={[{ key: "summary", label: "Summary CSV" }, { key: "points", label: "Points CSV" }]}
        />
      </div>
      <h3>Overview</h3>
      <AreaClubsOverview clubYear={clubYear} clubs={clubs} links={links} />
      <h3>Monthly reports</h3>
      <AreaMonthlyReportsTable clubYear={clubYear} clubs={clubs} links={links} />
      <h3>Points</h3>
      <AreaPointsChart basePath="/admin/clubs/summary" clubYear={clubYear} clubs={clubs} sort={parseLeaderboardSort(params.sort)} />
      <h3>Club events</h3>
      <AreaClubEvents clubHref={links.clubHref} events={events} />
    </section>
  );
}
