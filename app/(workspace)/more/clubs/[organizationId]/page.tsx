import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { BackgroundCheckList } from "@/components/background-check-flags";
import { listEventBackgroundFlags } from "@/modules/background-checks/repository";
import { ClubOverview } from "@/components/club-overview";
import { getPrisma } from "@/lib/prisma";
import { getClubAssignmentForClub } from "@/modules/club-registrations/assignments-repository";
import { isClubRegisteredForEvent, resolveClubOversight } from "@/modules/club-rosters/event-oversight";

export const metadata: Metadata = { title: "Club" };
export const dynamic = "force-dynamic";

/** One registered club, view only with ages, for this event's managers (#387). */
export default async function EventClubPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const [{ organizationId }, { event: requested }] = await Promise.all([params, searchParams]);
  const { event, allowed } = await resolveClubOversight(requested);
  if (!allowed) return <AccessRestricted title="Club oversight is restricted" detail="Event administrators of this Pathfinder event can view its clubs." />;
  // Only clubs registered for this event: the role is for this event only.
  if (!(await isClubRegisteredForEvent(event.id, organizationId))) notFound();
  const club = await getPrisma().organization.findUnique({ where: { id: organizationId }, select: { name: true, parentOrganization: { select: { name: true } } } });
  if (!club) notFound();
  const query = `?event=${event.id}`;
  const selfHref = `/more/clubs/${organizationId}${query}`;
  const fromHere = `${query}&from=${encodeURIComponent(selfHref)}`;
  const backgroundFlags = await listEventBackgroundFlags(event.id, { organizationId });
  const assignment = await getClubAssignmentForClub(event.id, organizationId);
  return (
    <section className="page-stack">
      <BackLink href={`/more/clubs${query}`} variant="staff">Back to clubs</BackLink>
      <div className="page-intro">
        <div>
          <p className="eyebrow">{event.name} · view only</p>
          <h2 translate="no">{club.name}</h2>
          {club.parentOrganization && <p translate="no">{club.parentOrganization.name}</p>}
        </div>
      </div>
      <p className="inline-notice" role="status"><Eye aria-hidden="true" size={14} /> View only, with ages instead of birth dates. The club makes changes.</p>
      {backgroundFlags && (
        <section className="panel" id="background-checks">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Youth or children&apos;s event · the club doesn&apos;t see this</p>
              <h2>Background check needed</h2>
              <p>Adults from this club with no Sterling Volunteers check good through {backgroundFlags.lastDay}. Nothing is blocked.</p>
            </div>
          </div>
          <BackgroundCheckList people={backgroundFlags.people} registrationHref={{ base: "/people", query: `event=${encodeURIComponent(event.id)}` }} showClub={false} />
        </section>
      )}
      {assignment && (
        <section className="panel">
          <h3>Assignments</h3>
          <ul className="quiet-copy compact-list">
            {assignment.fields.campsiteLocation && <li>Campsite: {assignment.fields.campsiteLocation}</li>}
            {assignment.fields.dutyLabel && <li>Duty: {assignment.fields.dutyLabel}{assignment.fields.dutyDay ? ` — ${assignment.fields.dutyDay}` : ""}{assignment.fields.dutyTime ? ` ${assignment.fields.dutyTime}` : ""}</li>}
            {assignment.fields.activityLabel && <li>Activity: {assignment.fields.activityLabel}</li>}
          </ul>
        </section>
      )}
      <ClubOverview
        organizationId={organizationId}
        reportHref={(month) => `/more/clubs/reports/${organizationId}/${month}${fromHere}`}
        reportsEditable={false}
      />
    </section>
  );
}
