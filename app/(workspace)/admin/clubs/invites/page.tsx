import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ClubInvitesWorkspace } from "@/components/club-invites-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { listClubInvites } from "@/modules/club-imports/invites";
import { isAccountEmailConfigured } from "@/modules/communications/account-email";

export const metadata: Metadata = { title: "Club invites" };
export const dynamic = "force-dynamic";

export default async function ClubInvitesPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin/organizations">Back to churches and clubs</Link>
      <ClubInvitesWorkspace emailConfigured={isAccountEmailConfigured()} initialInvites={await listClubInvites()} />
    </>
  );
}
