import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ChurchMapLocationsWorkspace } from "@/components/church-map-locations-workspace";
import { geocodingEnabled } from "@/integrations/geocoding";
import { getCurrentSession } from "@/modules/access/current-session";
import { countGeocodableChurches, listGeocodeReview } from "@/modules/organizations/church-geocoding";

export const metadata: Metadata = { title: "Find map locations" };

/** Staff-triggered lookup of church map points, with a review list (#724). System administrators only. */
export default async function ChurchMapLocationsPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const [eligible, items] = await Promise.all([countGeocodableChurches(), listGeocodeReview()]);
  return (
    <>
      <div className="intro-actions club-admin-links">
        <BackLink href="/admin/organizations/directory" variant="staff">Back to Organization directory</BackLink>
      </div>
      <section className="page-stack" aria-labelledby="map-locations-title">
        <div className="page-intro">
          <div>
            <p className="eyebrow">Clubs and churches</p>
            <h2 id="map-locations-title">Find map locations</h2>
            <p>Looks up map points for imported churches so their clubs appear on the public club map. Review each match before it is used.</p>
          </div>
        </div>
        <ChurchMapLocationsWorkspace enabled={geocodingEnabled()} eligible={eligible} items={items} />
      </section>
    </>
  );
}
