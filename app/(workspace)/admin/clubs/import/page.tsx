import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ClubImportWorkspace } from "@/components/club-import-workspace";
import { getCurrentSession } from "@/modules/access/current-session";

export const metadata: Metadata = { title: "Import clubs" };

export default async function ClubImportPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin/organizations">Back to churches and clubs</Link>
      <ClubImportWorkspace />
    </>
  );
}
