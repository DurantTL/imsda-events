import { notFound, redirect } from "next/navigation";
import { AccountSectionNav } from "@/components/account-section-nav";
import { ClubAccessGate } from "@/components/club-access-gate";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

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
  const access = await getRosterAccessState(organizationId);
  if (access.state === "SIGN_IN") redirect("/account/sign-in");
  if (access.state === "NOT_FOUND") notFound();
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
              { href: `${base}/events`, label: "Events & classes", matchChildren: true },
            ]}
            label="Club"
            variant="secondary"
          />
        ) : (
          <ClubAccessGate access={access} />
        )}
        {children}
      </div>
    </>
  );
}
