import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AccountSectionNav } from "@/components/account-section-nav";
import Link from "next/link";
import { ClubAccessGate } from "@/components/club-access-gate";
import { ClubGateSlot, ClubRecordsHint } from "@/components/club-gate-slot";
import { attendeeSignInRedirectPath } from "@/modules/attendee-accounts/return-redirect";
import { requireAttendeeSecondStep } from "@/modules/attendee-accounts/portal-second-step";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { clubPortalNavItems, clubReporterNavItems } from "@/modules/club-rosters/portal-nav";
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
  if (access.state === "SIGN_IN") redirect(await attendeeSignInRedirectPath());
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
            items={clubPortalNavItems({ base, role: access.club.role, capabilities: access.capabilities })}
            label="Club"
            variant="secondary"
          />
        ) : access.state === "NO_ROSTER" ? (
          <AccountSectionNav
            items={clubReporterNavItems({ base, capabilities: access.capabilities })}
            label="Club"
            variant="secondary"
          />
        ) : (
          <ClubGateSlot>
            <ClubAccessGate access={access} />
            {"club" in access && clubCapabilities(access.club.role).submitReports && (
              <ClubRecordsHint>
                <p className="field-help club-gate-reports">
                  Monthly Records open without this step, except the attendance check-off: <Link href={`${base}/records`}>open Monthly Records</Link>.
                </p>
              </ClubRecordsHint>
            )}
          </ClubGateSlot>
        )}
        {children}
      </div>
    </>
  );
}
