import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ChurchLocationForm } from "@/components/church-location-form";
import { getCurrentSession } from "@/modules/access/current-session";
import { getChurchLocation } from "@/modules/organizations/church-location-repository";

export const metadata: Metadata = { title: "Church location" };

/**
 * Conference staff enter a church's town and, optionally, its map
 * coordinates (#437). Coordinates are typed in here, by hand — nothing
 * geocodes them. Used only to plot the church's listed clubs on the public
 * club map.
 */
export default async function StaffChurchLocationPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { organizationId } = await params;
  const location = await getChurchLocation(organizationId);
  if (!location) notFound();
  return (
    <section className="page-stack">
      <BackLink href="/admin/organizations" variant="staff">Back to churches and clubs</BackLink>
      <ChurchLocationForm
        endpoint={`/api/admin/organizations/${encodeURIComponent(organizationId)}/location`}
        initialLocation={location}
      />
    </section>
  );
}
