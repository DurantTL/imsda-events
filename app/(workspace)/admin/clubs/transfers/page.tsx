import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubTransferQueue } from "@/components/club-transfer-queue";
import { RegistrationMoveApprovals } from "@/components/registration-move-approvals";
import { getCurrentSession } from "@/modules/access/current-session";

export const metadata: Metadata = { title: "Club member transfers" };
export const dynamic = "force-dynamic";

/** Conference staff (#489): the transfer queue and the registration-move approval list. System administrators only. */
export default async function ClubTransfersAdminPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  return (
    <>
      <BackLink href="/admin/organizations" variant="staff">Back to churches and clubs</BackLink>
      <ClubTransferQueue />
      <RegistrationMoveApprovals />
    </>
  );
}
