import { redirect } from "next/navigation";

/** Supplies moved inside Orders (#654): the Area Coordinator's view is the Inventory section there. */
export default async function AreaClubSuppliesPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  redirect(`/account/area/${encodeURIComponent(organizationId)}/orders#inventory`);
}
