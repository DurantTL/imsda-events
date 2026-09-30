import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { OrganizationDirectoryWorkspace } from "@/components/organization-directory-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { listOrganizations } from "@/modules/organizations/repository";

export const metadata: Metadata = { title: "Clubs and churches" };

export default async function OrganizationsPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  return (
    <>
      <div className="intro-actions club-admin-links">
        <BackLink href="/admin" variant="staff">Back to system administration</BackLink>
        <Link className="secondary-button" href="/admin/clubs/import">Import clubs</Link>
        <Link className="secondary-button" href="/admin/organizations/directory">Organization directory</Link>
        <Link className="secondary-button" href="/admin/organizations/import">Import from eAdventist</Link>
        <Link className="secondary-button" href="/admin/clubs/invites">Club invites</Link>
        <Link className="secondary-button" href="/admin/clubs/reports">Monthly reports</Link>
        <Link className="secondary-button" href="/admin/clubs/summary">Club summary</Link>
        <Link className="secondary-button" href="/admin/clubs/transfers">Member transfers</Link>
        <Link className="secondary-button" href="/admin/organizations/background-checks">Background checks</Link>
      </div>
      <OrganizationDirectoryWorkspace
        initialOrganizations={await listOrganizations()}
      />
    </>
  );
}
