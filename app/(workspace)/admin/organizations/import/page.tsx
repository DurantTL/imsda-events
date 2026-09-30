import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { EadventistImportWorkspace } from "@/components/eadventist-import-workspace";
import { getCurrentSession } from "@/modules/access/current-session";

export const metadata: Metadata = { title: "Import organizations" };

export default async function EadventistImportPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  return (
    <>
      <BackLink href="/admin/organizations" variant="staff">Back to Clubs and churches</BackLink>
      <EadventistImportWorkspace />
    </>
  );
}
