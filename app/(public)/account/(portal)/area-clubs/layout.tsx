import { notFound } from "next/navigation";
import { AccountSectionNav } from "@/components/account-section-nav";
import { currentAreaCoordinatorViewerActive } from "@/modules/organizations/area-coordinators";

/** The Area Coordinator's Clubs section (#657): its own menu, view only, nothing for anyone but a coordinator. */
export default async function AreaClubsLayout({ children }: { children: React.ReactNode }) {
  if (!(await currentAreaCoordinatorViewerActive())) notFound();
  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Area Coordinator · view only</p>
          <h1>Clubs</h1>
        </div>
      </section>
      <AccountSectionNav
        items={[
          { href: "/account/clubs", label: "All clubs" },
          { href: "/account/area-clubs/overview", label: "Overview" },
          { href: "/account/area-clubs/reports", label: "Monthly reports" },
          { href: "/account/area-clubs/points", label: "Points" },
          { href: "/account/area-clubs/events", label: "Club events" },
        ]}
        label="Clubs"
        variant="secondary"
      />
      <div className="account-page-body">{children}</div>
    </>
  );
}
