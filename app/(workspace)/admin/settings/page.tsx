import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PlatformSettingsWorkspace } from "@/components/platform-settings-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { getPlatformSettings } from "@/modules/system-admin/platform-settings";

export const metadata: Metadata = { title: "Platform settings" };

export default async function PlatformSettingsPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin">
        Back to system administration
      </Link>
      <PlatformSettingsWorkspace initialSettings={await getPlatformSettings()} />
    </>
  );
}
