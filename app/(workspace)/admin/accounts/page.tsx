import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AttendeeAccountsWorkspace } from "@/components/attendee-accounts-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { listAttendeeAccounts } from "@/modules/system-admin/user-admin";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

export default async function AttendeeAccountsPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin">Back to system administration</Link>
      <AttendeeAccountsWorkspace initialAccounts={await listAttendeeAccounts("")} />
    </>
  );
}
