import type { Metadata } from "next";
import Link from "next/link";
import { BackLink } from "@/components/back-link";
import { HonorsPrintReport } from "@/components/honors-print-report";
import { PrintReportButton } from "@/components/print-report-button";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { clubHonorCounts, memberCompletedHonors } from "@/modules/reporting/director-exports";
import { listExportMemberOptions, loadHonorsExport } from "@/modules/reporting/director-exports-repository";

export const metadata: Metadata = { title: "Honors report" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/**
 * The printable honors report (#819): either one person's completed honors, or
 * the whole club's completed honors with how many members completed each. The
 * whole-club view never loads the member list or passes a name to the page.
 */
export default async function ClubHonorsReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ organizationId }, query] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const { clubYear, choices } = rosterYearView(one(query.year));
  const person = one(query.view) === "person";
  const memberId = one(query.member);
  const base = `/account/clubs/${organizationId}/exports/honors`;
  const members = person ? await listExportMemberOptions(organizationId, clubYear) : [];
  const chosen = members.find((member) => member.memberId === memberId);
  const { rows } = person && !chosen ? { rows: [] } : await loadHonorsExport(organizationId, clubYear, { memberId: chosen?.memberId });
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}/honors`}>Back to honors</BackLink>
      <section className="panel honors-report-panel" aria-labelledby="honors-report-heading">
        <h2 id="honors-report-heading">Honors report: {access.club.name}, {clubYear}</h2>
        <nav aria-label="Report type" className="honors-report-modes">
          <Link aria-current={person ? undefined : "page"} className="honors-report-mode" href={`${base}?year=${encodeURIComponent(clubYear)}`}>Whole club</Link>
          <Link aria-current={person ? "page" : undefined} className="honors-report-mode" href={`${base}?year=${encodeURIComponent(clubYear)}&view=person`}>One person</Link>
        </nav>
        <form aria-label="Report options" className="honors-report-controls report-actions" method="get">
          <input name="view" type="hidden" value={person ? "person" : "club"} />
          <label>
            Club year
            <select defaultValue={clubYear} name="year">
              {choices.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
          </label>
          {person && (
            <label className="honors-report-member">
              Member
              <select defaultValue={chosen?.memberId ?? ""} name="member">
                <option value="">Choose a member</option>
                {members.map((member) => <option key={member.memberId} value={member.memberId}>{member.label}</option>)}
              </select>
            </label>
          )}
          <div className="honors-report-buttons">
            <button className="primary-button" type="submit">Show report</button>
            {(!person || chosen) && <PrintReportButton label="Print" />}
          </div>
        </form>
        {person && !chosen ? (
          <p className="muted">Choose a member to print their completed honors.</p>
        ) : (
          <>
            {person && chosen ? (
              <HonorsPrintReport clubName={access.club.name} clubYear={clubYear} honors={memberCompletedHonors(rows)} memberLabel={chosen.label} scope="MEMBER" />
            ) : (
              <HonorsPrintReport clubName={access.club.name} clubYear={clubYear} honors={clubHonorCounts(rows)} scope="CLUB" />
            )}
          </>
        )}
      </section>
    </>
  );
}
