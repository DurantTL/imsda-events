import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SystemReadinessWorkspace } from "@/components/system-readiness-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { getSystemReadiness } from "@/modules/system-admin/readiness-repository";

export const metadata: Metadata = { title: "System readiness" };
export const dynamic = "force-dynamic";

export default async function SystemReadinessPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin">
        Back to system administration
      </Link>
      <SystemReadinessWorkspace initialReadiness={await getSystemReadiness()} />
    </>
  );
}
