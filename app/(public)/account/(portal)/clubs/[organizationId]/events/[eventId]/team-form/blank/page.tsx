import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { PrintReportButton } from "@/components/print-report-button";
import { TeamFormSheet } from "@/components/team-form-sheet";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { loadBlankTeamForm } from "@/modules/club-teams/team-form-repository";

export const metadata: Metadata = { title: "Blank team form" };
export const dynamic = "force-dynamic";

/** The blank team form (#809), for a club that mails or emails the paper instead of registering online. */
export default async function DirectorBlankTeamFormPage({ params }: { params: Promise<{ organizationId: string; eventId: string }> }) {
  const { organizationId, eventId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const form = await loadBlankTeamForm(eventId, { publishedClubOnly: true });
  if (!form) notFound();
  return (
    <section className="page-stack retreat-packet-workspace">
      <div className="page-intro retreat-packet-intro">
        <div>
          <BackLink href={`/account/clubs/${organizationId}/events/${eventId}`}>Back to {form.eventName}</BackLink>
          <h2>Blank team form</h2>
          <p>Print this to fill in by hand and mail or email to the Youth Department.</p>
        </div>
        <PrintReportButton label="Print the blank form" />
      </div>
      <TeamFormSheet model={form.model} />
    </section>
  );
}
