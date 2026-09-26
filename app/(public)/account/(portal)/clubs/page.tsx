import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, UsersRound } from "lucide-react";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { isAreaCoordinator, listClubsForArea } from "@/modules/organizations/area-coordinators";
import { listDirectedClubs } from "@/modules/organizations/director-access";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";
import { currentStaffActingContext } from "@/modules/organizations/staff-act-as";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "My clubs",
  robots: { index: false, follow: false, nocache: true },
};

export default async function MyClubsPage() {
  const { account } = await getCurrentAttendee();
  const acting = await currentStaffActingContext();
  if (!account && !acting) redirect("/account/sign-in");

  // A staff "act as" director (#442) has nowhere else to go but their one
  // club: no attendee account, so no clubs list to show.
  if (acting?.role === "CLUB_DIRECTOR" && acting.organizationId) {
    redirect(`/account/clubs/${acting.organizationId}`);
  }

  const [clubs, areaCoordinator] = account
    ? await Promise.all([listDirectedClubs(account.id), isAreaCoordinator(account.id)])
    : [[], false];
  if (areaCoordinator || acting?.role === "AREA_COORDINATOR") {
    // An Area Coordinator sees every club (#387): their own open as usual;
    // the rest open view only.
    const own = new Map(clubs.map((club) => [club.organizationId, club]));
    const allClubs = await listClubsForArea();
    return (
      <>
        <section className="public-registration-hero public-manage-hero account-page-hero">
          <div>
            <p className="public-registration-eyebrow">Area Coordinator</p>
            <h1>Clubs</h1>
          </div>
        </section>
        <div className="account-page-body">
          <section className="public-manage-card">
            <p className="field-help">Every active club. Clubs you don&apos;t run open view only, with ages instead of birth dates.</p>
            <ul className="public-manage-club-list">
              {allClubs.map((club) => {
                const mine = own.get(club.organizationId);
                return (
                  <li key={club.organizationId}>
                    <UsersRound size={17} aria-hidden="true" />
                    <span>
                      <strong translate="no">{club.name}</strong>
                      <small>
                        {mine ? clubDirectorRoleLabels[mine.role] : "View only"}
                        {club.sponsoringChurch && <> · <span translate="no">{club.sponsoringChurch}</span></>}
                      </small>
                    </span>
                    <Link
                      className={`${mine ? "primary-button" : "secondary-button"} club-event-action`}
                      href={mine ? `/account/clubs/${club.organizationId}` : `/account/area/${club.organizationId}`}
                    >
                      Open <ArrowRight size={14} aria-hidden="true" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </>
    );
  }
  // Most directors run one club: take them straight to it.
  if (clubs.length === 1) redirect(`/account/clubs/${clubs[0].organizationId}`);

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Club ministries</p>
          <h1>My clubs</h1>
        </div>
      </section>
      <div className="account-page-body">
        <section className="public-manage-card">
          {clubs.length === 0 ? (
            <p className="public-manage-empty">
              <UsersRound size={17} aria-hidden="true" /> You aren&apos;t a director of a club right now. The conference
              office adds club directors.
            </p>
          ) : (
            <ul className="public-manage-club-list">
              {clubs.map((club) => (
                <li key={club.organizationId}>
                  <UsersRound size={17} aria-hidden="true" />
                  <span>
                    <strong translate="no">{club.name}</strong>
                    <small>
                      {clubDirectorRoleLabels[club.role]}
                      {club.sponsoringChurch && <> · <span translate="no">{club.sponsoringChurch}</span></>}
                    </small>
                  </span>
                  <Link className="primary-button club-event-action" href={`/account/clubs/${club.organizationId}`}>
                    Open <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
