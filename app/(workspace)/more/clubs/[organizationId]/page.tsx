import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { ClubOverview } from "@/components/club-overview";
import { getPrisma } from "@/lib/prisma";
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
  return (
    <section className="page-stack">
      <Link className="secondary-button more-back-link" href={`/more/clubs${query}`}>Back to clubs</Link>
      <div className="page-intro">
        <div>
          <p className="eyebrow">{event.name} · view only</p>
          <h2 translate="no">{club.name}</h2>
          {club.parentOrganization && <p translate="no">{club.parentOrganization.name}</p>}
        </div>
      </div>
      <p className="inline-notice" role="status"><Eye aria-hidden="true" size={14} /> View only, with ages instead of birth dates. The club makes changes.</p>
      <ClubOverview
        organizationId={organizationId}
        reportHref={(month) => `/more/clubs/reports/${organizationId}/${month}${query}`}
        reportsEditable={false}
      />
    </section>
  );
}
