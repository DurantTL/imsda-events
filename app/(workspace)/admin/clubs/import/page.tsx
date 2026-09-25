import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubImportWorkspace } from "@/components/club-import-workspace";
import { getCurrentSession } from "@/modules/access/current-session";

export const metadata: Metadata = { title: "Import clubs" };

export default async function ClubImportPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  return (
    <>
      <BackLink href="/admin/organizations" variant="staff">Back to churches and clubs</BackLink>
      <ClubImportWorkspace />
    </>
  );
}
