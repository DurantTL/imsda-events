import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TeamDirectoryWorkspace } from "@/components/team-directory-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { getTeamDirectory } from "@/modules/system-admin/team-directory";

export const metadata: Metadata = { title: "Team" };

export default async function TeamDirectoryPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin">
        Back to system administration
      </Link>
      <TeamDirectoryWorkspace
        initialDirectory={await getTeamDirectory()}
        currentUserId={user.id}
      />
    </>
  );
}
