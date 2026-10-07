import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { PrintReportButton } from "@/components/print-report-button";
import { TeamFormSheet } from "@/components/team-form-sheet";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { singleSearchParam } from "@/modules/club-teams/domain";
import { loadFilledTeamForm } from "@/modules/club-teams/team-form-repository";

export const metadata: Metadata = { title: "Team form" };
export const dynamic = "force-dynamic";

/**
 * A director's own team form (#809), filled in from the team's registration. The club comes from the verified roster access,
 * never from the address, so a director can never print another club's team by editing the URL; a team this club never
 * registered, or a repeated ?team=, is not found.
 */
export default async function DirectorTeamFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; eventId: string }>;
  searchParams: Promise<{ team?: string | string[] }>;
}) {
  const { organizationId, eventId } = await params;
  const teamKey = singleSearchParam((await searchParams).team);
  if (teamKey === null) notFound();
  const access = await getRosterAccessStateForPage(organizationId);
  // The club layout shows the sign-in and authenticator steps.
  if (access.state !== "OPEN") return null;
  const form = await loadFilledTeamForm({ eventId, organizationId: access.club.organizationId, teamKey });
  if (!form) notFound();
  const back = `/account/clubs/${organizationId}/events/${eventId}${teamKey ? `?team=${encodeURIComponent(teamKey)}` : ""}`;
  return (
    <section className="page-stack retreat-packet-workspace">
      <div className="page-intro retreat-packet-intro">
        <div>
          <BackLink href={back}>Back to {form.eventName}</BackLink>
          <h2>{form.title}</h2>
          <p>Your team&apos;s participating form, on one letter page.</p>
        </div>
        <PrintReportButton label="Print this form" />
      </div>
      <TeamFormSheet model={form.model} />
    </section>
  );
}
