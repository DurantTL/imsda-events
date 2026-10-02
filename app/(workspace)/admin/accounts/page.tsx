import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActAsButton } from "@/components/act-as-button";
import { AttendeeAccountsWorkspace } from "@/components/attendee-accounts-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { parseAccountSort } from "@/modules/system-admin/account-sort";
import { listAttendeeAccounts } from "@/modules/system-admin/user-admin";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

export default async function AttendeeAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; dir?: string }>;
}) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  // Search and sort live in the URL (#738) so a reload or shared link keeps them.
  const params = await searchParams;
  const initialQuery = typeof params.q === "string" ? params.q.slice(0, 120) : "";
  const initialSort = parseAccountSort(params.sort, params.dir);
  return (
    <>
      <div className="intro-actions club-admin-links">
        <Link className="secondary-button more-back-link" href="/admin">Back to system administration</Link>
        <ActAsButton
          access="View only"
          endpoint="/api/admin/act-as/area-coordinator"
          label="Act as Area Coordinator (2 hours)"
          resultAction="Open the coordinator view"
          role="Area Coordinator"
        />
      </div>
      <AttendeeAccountsWorkspace
        initialAccounts={await listAttendeeAccounts(initialQuery, initialSort)}
        initialQuery={initialQuery}
        initialSort={initialSort}
      />
    </>
  );
}
