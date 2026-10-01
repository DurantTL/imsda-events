import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { getPrisma } from "@/lib/prisma";
import { CLUB_REGISTRATION_NOT_A_DIRECTOR_MESSAGE } from "@/modules/club-registrations/entry-path";
import { getDirectedClubsForCurrentAttendee } from "@/modules/organizations/director-access";
import { clubCapabilities, clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

export const metadata: Metadata = {
  title: "Register your club",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

/**
 * The club door from a public event page (#720). The portal layout above
 * already sends a signed-out visitor to sign-in and back here. A signed-in
 * visitor with exactly one club that may register goes straight to that club's
 * registration for the event; with several they choose; with none they are
 * told plainly why they cannot continue.
 */
export default async function ClubRegistrationEntryPage({
  params,
}: {
  params: Promise<{ eventSlug: string }>;
}) {
  const { eventSlug } = await params;
  const event = await getPrisma().event.findFirst({
    where: { slug: eventSlug, isPublished: true, audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" },
    select: { id: true, name: true, slug: true },
  });
  if (!event) notFound();

  const clubs = (await getDirectedClubsForCurrentAttendee()).filter((club) => clubCapabilities(club.role).registerForEvents);
  if (clubs.length === 1) {
    redirect(`/account/clubs/${clubs[0]!.organizationId}/events/${event.id}`);
  }

  return (
    <section className="public-manage-card" aria-labelledby="club-entry-heading">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Register your club</p>
        <h1 id="club-entry-heading">{event.name}</h1>
      </div>
      {clubs.length === 0 ? (
        <>
          <p className="public-manage-empty">{CLUB_REGISTRATION_NOT_A_DIRECTOR_MESSAGE}</p>
          <p className="field-help">
            If you direct a club and expected to see it, contact the conference office. Not part of a club?{" "}
            <Link href={`/events/${encodeURIComponent(event.slug)}`}>Back to the event page</Link>.
          </p>
        </>
      ) : (
        <>
          <p className="field-help">Choose the club you are registering.</p>
          <ul className="public-manage-club-list">
            {clubs.map((club) => (
              <li key={club.organizationId}>
                <span>
                  <strong translate="no">{club.name}</strong>
                  <small>{clubDirectorRoleLabels[club.role]}</small>
                </span>
                <Link className="primary-button club-event-action" href={`/account/clubs/${club.organizationId}/events/${event.id}`}>
                  Register <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
