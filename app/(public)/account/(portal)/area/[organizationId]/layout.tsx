import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { AccountSectionNav } from "@/components/account-section-nav";
import { BackLink } from "@/components/back-link";
import { getPrisma } from "@/lib/prisma";
import { areaClubPortalNavItems } from "@/modules/club-rosters/portal-nav";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

/**
 * An Area Coordinator's view of one club (#722): the club portal's hero and
 * menu in a view-only form. Like the director's layout it is only chrome;
 * every page below checks access itself (a layout is not a security boundary).
 */
export default async function AreaClubLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ organizationId: string }>;
}) {
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  const { organizationId } = await params;
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, name: true, isActive: true, parentOrganization: { select: { name: true } } },
  });
  if (!club || club.type !== "CLUB" || !club.isActive) notFound();

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Area Coordinator · view only</p>
          <h1 translate="no">{club.name}</h1>
          {club.parentOrganization && <p translate="no">{club.parentOrganization.name}</p>}
        </div>
      </section>
      <div className="club-roster-layout area-club-layout">
        <BackLink href="/account/clubs">All clubs</BackLink>
        <AccountSectionNav items={areaClubPortalNavItems({ organizationId })} label="Club" variant="secondary" />
        <p className="inline-notice" role="status">
          <Eye aria-hidden="true" size={14} /> View only. You see what the club&apos;s director sees, with ages instead of
          birth dates. The club makes changes.
        </p>
        {children}
      </div>
    </>
  );
}
