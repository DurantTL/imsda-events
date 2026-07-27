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
      <Link className="secondary-button more-back-link" href="/admin">
        Back to system administration
      </Link>
      <OrganizationDirectoryWorkspace
        initialOrganizations={await listOrganizations()}
      />
    </>
  );
}
