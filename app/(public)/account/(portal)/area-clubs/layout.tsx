import { notFound } from "next/navigation";
import { AreaClubsSubNav } from "@/components/area-clubs-subnav";
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
      <AreaClubsSubNav />
      <div className="account-page-body">{children}</div>
    </>
  );
}
