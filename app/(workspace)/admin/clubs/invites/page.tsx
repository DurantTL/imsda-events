import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
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
      <BackLink href="/admin/organizations" variant="staff">Back to churches and clubs</BackLink>
      <ClubInvitesWorkspace emailConfigured={isAccountEmailConfigured()} initialInvites={await listClubInvites()} />
    </>
  );
}
