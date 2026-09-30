import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ListChecks } from "lucide-react";
import { getPrisma } from "@/lib/prisma";
import { listWaitingClubsForCoordinator } from "@/modules/event-locations/waitlist";
import { currentAreaCoordinator } from "@/modules/organizations/area-coordinators";

export const metadata: Metadata = { title: "Waitlists", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * The clubs waitlisted at each location an Area Coordinator coordinates (#599),
 * in each location's own first-come order. View only: promotion happens when a
 * seat opens, or by event staff.
 */
export default async function AreaWaitlistsPage() {
  const coordinator = await currentAreaCoordinator();
  if (!coordinator) notFound();
  const locations = await listWaitingClubsForCoordinator(getPrisma(), coordinator.id);
  const withClubs = locations.filter((location) => location.clubs.length > 0);

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Area Coordinator · view only</p>
          <h1>Waitlists</h1>
        </div>
      </section>
      <div className="account-page-body">
        <section className="public-manage-card">
          {locations.length === 0 ? (
            <p className="public-manage-empty">
              <ListChecks size={17} aria-hidden="true" /> You aren&apos;t set as the coordinator of any event location yet.
              Event staff choose the coordinator for each location.
            </p>
          ) : withClubs.length === 0 ? (
            <p className="public-manage-empty">
              <ListChecks size={17} aria-hidden="true" /> No clubs are waiting at your locations right now. Check back after a location fills up.
            </p>
          ) : (
            withClubs.map((location) => (
              <div key={location.locationId}>
                <h2 translate="no">{location.locationName}</h2>
                <p className="field-help" translate="no">{location.eventName}</p>
                <ol className="public-manage-club-list">
                  {location.clubs.map((club) => (
                    <li key={club.registrationId}>
                      <span>
                        <strong translate="no">#{club.place} · {club.clubName}</strong>
                        <small>
                          {club.attendeeCount} {club.attendeeCount === 1 ? "person" : "people"} · joined{" "}
                          {new Date(club.joinedAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/Chicago" })}
                        </small>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  );
}
