import { redirect } from "next/navigation";

/**
 * Supplies moved inside Orders (#654): the club's supplies on hand are the
 * Inventory section there. The old address keeps working.
 */
export default async function ClubSuppliesPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  redirect(`/account/clubs/${encodeURIComponent(organizationId)}/orders#inventory`);
}
