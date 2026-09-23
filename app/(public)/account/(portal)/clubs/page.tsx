import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, UsersRound } from "lucide-react";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { listDirectedClubs } from "@/modules/organizations/director-access";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "My clubs",
  robots: { index: false, follow: false, nocache: true },
};

export default async function MyClubsPage() {
  const { account } = await getCurrentAttendee();
  if (!account) redirect("/account/sign-in");
  const clubs = await listDirectedClubs(account.id);
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
