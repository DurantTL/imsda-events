import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AccountSectionNav } from "@/components/account-section-nav";
import Link from "next/link";
import { ClubAccessGate } from "@/components/club-access-gate";
import { ClubGateSlot } from "@/components/club-gate-slot";
import { requireAttendeeSecondStep } from "@/modules/attendee-accounts/portal-second-step";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { clubCapabilities, clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

// Every page under a club's portal is an authenticated leader/director
// destination (#108): noindex here covers each one that doesn't set its own
// `robots`, the same way the sibling `area/[organizationId]` pages already do.
export const metadata: Metadata = { robots: { index: false, follow: false, nocache: true } };

/**
 * Every club screen shares the club's name, its tabs, and the authenticator
 * gate. Pages check access again before they load anything: a layout is not
 * a security boundary.
 */
export default async function ClubLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state === "SIGN_IN") redirect("/account/sign-in");
  if (access.state === "NOT_FOUND") notFound();
  // A club reached through the attendee's own account still needs the
  // attendee second step (the portal layout skips it while a staff act-as is
  // active, #442); the act-as club itself resolves from the staff session.
  if (!(access.state === "OPEN" && access.actor.kind === "STAFF_ACTING")) await requireAttendeeSecondStep();
  const base = `/account/clubs/${organizationId}`;

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">
            {clubDirectorRoleLabels[access.club.role]} · Club year {clubYearFor(new Date())}
          </p>
          <h1 translate="no">{access.club.name}</h1>
          {access.club.sponsoringChurch && <p translate="no">{access.club.sponsoringChurch}</p>}
        </div>
      </section>
      <div className="club-roster-layout">
        {access.state === "OPEN" ? (
          <AccountSectionNav
            items={[
              { href: base, label: "Club home" },
              { href: `${base}/roster`, label: "Roster" },
              // Honors open on the roster's own gate (#486), so the tab follows the roster capability.
              ...(access.capabilities.roster ? [{ href: `${base}/honors`, label: "Honors" }] : []),
              // Supplies open on the roster's gate too (#531): directors and deputies edit, registrars view.
              ...(access.capabilities.roster ? [{ href: `${base}/supplies`, label: "Supplies" }] : []),
              // Orders (honors, #487, and uniforms, #497) share the supplies gate.
              ...(access.capabilities.roster ? [{ href: `${base}/orders`, label: "Orders" }] : []),
              { href: `${base}/events`, label: "Events & classes", matchChildren: true },
              ...(access.capabilities.submitReports ? [
                { href: `${base}/notes`, label: "Meeting notes", matchChildren: true },
                { href: `${base}/reports`, label: "Monthly reports", matchChildren: true },
              ] : []),
              ...(access.capabilities.manageTeam ? [{ href: `${base}/team`, label: "Club admins" }] : []),
              ...(access.capabilities.editProfile ? [{ href: `${base}/profile`, label: "Club profile" }] : []),
            ]}
            label="Club"
            variant="secondary"
          />
        ) : access.state === "NO_ROSTER" ? (
          <AccountSectionNav
            items={[
              { href: base, label: "Club home" },
              ...(access.capabilities.submitReports ? [
                { href: `${base}/notes`, label: "Meeting notes", matchChildren: true },
                { href: `${base}/reports`, label: "Monthly reports", matchChildren: true },
              ] : []),
            ]}
            label="Club"
            variant="secondary"
          />
        ) : (
          <ClubGateSlot>
            <ClubAccessGate access={access} />
            {"club" in access && clubCapabilities(access.club.role).submitReports && (
              <p className="field-help club-gate-reports">
                Monthly reports don&apos;t need this step: <Link href={`${base}/reports`}>open monthly reports</Link>.
              </p>
            )}
          </ClubGateSlot>
        )}
        {children}
      </div>
    </>
  );
}
