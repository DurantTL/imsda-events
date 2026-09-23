import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { ClubAccessGate } from "@/components/club-access-gate";
import { ClubEventList } from "@/components/club-event-list";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";
import { listClubEvents } from "@/modules/club-registrations/repository";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

export const metadata: Metadata = { title: "Club roster" };

export default async function ClubRosterPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state === "SIGN_IN") redirect("/account/sign-in");
  if (access.state === "NOT_FOUND") notFound();

  const clubYear = clubYearFor(new Date());
  const [members, clubEvents] = access.state === "OPEN"
    ? await Promise.all([listRoster(organizationId, clubYear), listClubEvents(organizationId)])
    : [[], []];

  return (
    <main className="public-registration-page public-manage-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/account">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
          <Link className="text-button" href="/account">Back to my account</Link>
        </div>
      </header>

      <section className="public-registration-hero public-manage-hero">
        <div>
          <p className="public-registration-eyebrow">
            {clubDirectorRoleLabels[access.club.role]} · Club year {clubYear}
          </p>
          <h1 translate="no">{access.club.name}</h1>
          {access.club.sponsoringChurch && <p translate="no">{access.club.sponsoringChurch}</p>}
        </div>
      </section>

      <div className="club-roster-layout">
        <ClubAccessGate access={access} />
        {access.state === "OPEN" && (
          <>
            <ClubEventList events={clubEvents} organizationId={organizationId} />
            <ClubRosterWorkspace clubYear={clubYear} initialMembers={members} organizationId={organizationId} />
          </>
        )}
      </div>
    </main>
  );
}
