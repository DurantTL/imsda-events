import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ClubDirectorsWorkspace } from "@/components/club-directors-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { listDirectorGrants } from "@/modules/organizations/director-grants-repository";
import { OrganizationOperationError } from "@/modules/organizations/repository";

export const metadata: Metadata = { title: "Club directors" };

export default async function ClubDirectorsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const { organizationId } = await params;
  let initial: Awaited<ReturnType<typeof listDirectorGrants>>;
  try {
    initial = await listDirectorGrants(organizationId);
  } catch (error) {
    if (error instanceof OrganizationOperationError) notFound();
    throw error;
  }

  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin/organizations">
        Back to churches and clubs
      </Link>
      <ClubDirectorsWorkspace club={initial.club} initialGrants={initial.grants} />
    </>
  );
}
