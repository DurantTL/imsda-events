import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Honors" };
export const dynamic = "force-dynamic";

/**
 * The old "Honors & class reports" page (#655) is gone (#701): its exports live
 * on the Honors and Class tracking pages. This keeps old links working; the
 * Honors page does its own access check.
 */
export default async function ClubExportsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  redirect(`/account/clubs/${organizationId}/honors`);
}
