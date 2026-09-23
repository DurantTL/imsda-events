import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { OrganizationDirectoryWorkspace } from "@/components/organization-directory-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { listOrganizations } from "@/modules/organizations/repository";

export const metadata: Metadata = { title: "Churches and clubs" };

export default async function OrganizationsPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  return (
    <>
      <div className="intro-actions club-admin-links">
        <Link className="secondary-button more-back-link" href="/admin">
          Back to system administration
        </Link>
        <Link className="secondary-button" href="/admin/clubs/import">Import clubs</Link>
        <Link className="secondary-button" href="/admin/clubs/invites">Club invites</Link>
      </div>
      <OrganizationDirectoryWorkspace
        initialOrganizations={await listOrganizations()}
      />
    </>
  );
}
