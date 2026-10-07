import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { PrintReportButton } from "@/components/print-report-button";
import { TeamFormSheet } from "@/components/team-form-sheet";
import { staffPageTitles } from "@/components/staff-navigation";
import { loadBlankTeamForm } from "@/modules/club-teams/team-form-repository";
import { resolveClubReportsAccess } from "@/modules/reporting/club-reports-access";

export const metadata: Metadata = { title: staffPageTitles.teamForm };
export const dynamic = "force-dynamic";

/** The blank team form (#809), for a club that mails or emails the paper. */
export default async function StaffBlankTeamFormPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, allowed } = await resolveClubReportsAccess(requested);
  if (!allowed) {
    return <AccessRestricted title="Team forms are restricted" detail="Ask an event administrator for report access to this club event." />;
  }
  const form = await loadBlankTeamForm(event.id);
  if (!form) notFound();
  return (
    <section className="page-stack retreat-packet-workspace">
      <div className="page-intro retreat-packet-intro">
        <div>
          <p className="eyebrow">{form.eventName}</p>
          <h2>Blank team form</h2>
          <p>Print this for a club that mails or emails the paper form.</p>
        </div>
        <div className="intro-actions">
          <Link className="secondary-button" href={`/more/team-results?event=${encodeURIComponent(event.id)}`}>Team results</Link>
          <PrintReportButton label="Print the blank form" />
        </div>
      </div>
      <TeamFormSheet model={form.model} />
    </section>
  );
}
