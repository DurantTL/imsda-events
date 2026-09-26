import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActAsButton } from "@/components/act-as-button";
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
      <div className="intro-actions club-admin-links">
        <Link className="secondary-button more-back-link" href="/admin">Back to system administration</Link>
        <ActAsButton
          confirmText="Act as an Area Coordinator for the next 2 hours? This is recorded and ends by itself (or with Stop acting), and never touches your own attendee account. Acting as an Area Coordinator is view only."
          endpoint="/api/admin/act-as/area-coordinator"
          label="Act as Area Coordinator (2 hours)"
        />
      </div>
      <AttendeeAccountsWorkspace initialAccounts={await listAttendeeAccounts("")} />
    </>
  );
}
