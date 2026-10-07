import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { PrintReportButton } from "@/components/print-report-button";
import { TeamFormSheet } from "@/components/team-form-sheet";
import { staffPageTitles } from "@/components/staff-navigation";
import { loadFilledTeamForm } from "@/modules/club-teams/team-form-repository";
import { resolveClubReportsAccess } from "@/modules/reporting/club-reports-access";

export const metadata: Metadata = { title: staffPageTitles.teamForm };
export const dynamic = "force-dynamic";

/** Staff's printable team form (#809), filled in from one team's registration. `registrationId` is the team's club registration id. */
export default async function StaffTeamFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ registrationId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const { registrationId } = await params;
  const { event: requested } = await searchParams;
  const { event, allowed } = await resolveClubReportsAccess(requested);
  if (!allowed) {
    return <AccessRestricted title="Team forms are restricted" detail="Ask an event administrator for report access to this club event." />;
  }
  const form = await loadFilledTeamForm({ eventId: event.id, clubEventRegistrationId: registrationId });
  if (!form) notFound();
  const query = `event=${encodeURIComponent(event.id)}`;
  return (
    <section className="page-stack retreat-packet-workspace">
      <div className="page-intro retreat-packet-intro">
        <div>
          <p className="eyebrow">{form.eventName}</p>
          <h2>{form.title}</h2>
          <p>The participating form, filled in from this team&apos;s registration, on one letter page.</p>
        </div>
        <div className="intro-actions">
          <Link className="secondary-button" href={`/more/team-results?${query}`}>Team results</Link>
          <Link className="secondary-button" href={`/more/reports/clubs/team-form?${query}`}>Blank form</Link>
          <PrintReportButton label="Print this form" />
        </div>
      </div>
      <TeamFormSheet model={form.model} />
    </section>
  );
}
